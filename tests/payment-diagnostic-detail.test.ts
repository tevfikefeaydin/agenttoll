import test from 'node:test';
import assert from 'node:assert/strict';
import { x402ResourceServer } from '@x402/core/server';
import { inspectPayment, paymentSnapshot, paymentTelemetry } from '../src/payment-telemetry.js';
import { explainPaymentDiagnostic, facilitatorExceptionDiagnostic, providerDiagnostic, requirementsDiagnostic,
  sanitizePaymentDiagnostic } from '../src/payment-diagnostic.js';
import { updateUsageArchive } from '../src/usage-archive.js';
import { summarizeUsageLogs } from '../src/usage-report.js';
import { summarizeRequests } from '../src/operations-report.js';

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64');
const secret = 'DO-NOT-LOG-SIGNATURE-OR-PROVIDER-TEXT';
const now = '2026-10-06T12:00:00.000Z';
const requirements = { scheme: 'exact', network: 'eip155:8453' as const, amount: '1000',
  asset: '0x' + '11'.repeat(20), payTo: '0x' + '22'.repeat(20), maxTimeoutSeconds: 300,
  extra: { name: 'USD Coin', version: '2' } };

test('parsing failures identify the boundary without retaining input or changing the rejection reason', () => {
  const cases = [
    ['x'.repeat(16385), 'header_too_large', 'malformed_payment'],
    [secret, 'header_decode_failed', 'malformed_payment'],
    [encode(null), 'payload_not_object', 'malformed_payment'],
    [encode({ x402Version: 1 }), 'unsupported_version', 'unsupported_version'],
    [encode({ x402Version: 2, payload: {} }), 'accepted_not_object', 'malformed_payment'],
    [encode({ x402Version: 2, accepted: {} }), 'authorization_not_object', 'malformed_payment'],
  ];
  for (const [header, code, reason] of cases) {
    const telemetry = paymentTelemetry(header, undefined);
    assert.equal(inspectPayment(header, undefined, telemetry), reason);
    assert.equal(telemetry.paymentDiagnostic?.code, code);
    assert.doesNotMatch(JSON.stringify(paymentSnapshot(telemetry)), /DO-NOT-LOG|xxxxxx/);
  }
  const legacy = paymentTelemetry(undefined, secret);
  assert.equal(inspectPayment(undefined, secret, legacy), 'unsupported_version');
  assert.equal(legacy.paymentDiagnostic?.code, 'legacy_header');
});

test('requirement diagnostics agree with SDK rejection and report field names only', () => {
  const matcher = new x402ResourceServer();
  const payload = (accepted: object) => ({ x402Version: 2, accepted, payload: { signature: secret } });
  const match = (accepted: object) => matcher.findMatchingRequirements([requirements], payload(accepted) as Parameters<typeof matcher.findMatchingRequirements>[1]);
  for (const field of ['scheme', 'network', 'asset', 'amount', 'payTo', 'maxTimeoutSeconds', 'extra']) {
    const accepted = { ...requirements, [field]: secret };
    assert.equal(match(accepted), undefined);
    const detail = requirementsDiagnostic([requirements], payload(accepted));
    assert.equal(detail.code, 'requirements_mismatch');
    assert.deepEqual(detail.mismatchFields, [field]);
    assert.doesNotMatch(JSON.stringify(detail), /DO-NOT-LOG|111111|222222/);
  }
  const withHint = { ...requirements, extra: { ...requirements.extra, newHint: secret } };
  assert.equal(match(withHint), requirements);
  assert.deepEqual(requirementsDiagnostic([requirements], payload(withHint)).mismatchFields, []);
  assert.equal(match({ ...requirements, [secret]: true }), undefined);
  assert.deepEqual(requirementsDiagnostic([requirements], payload({ ...requirements, [secret]: true })).mismatchFields, ['other']);
  assert.equal(requirementsDiagnostic([], payload(requirements)).code, 'requirements_unavailable');
  assert.equal(requirementsDiagnostic([requirements, requirements], payload(requirements)).code, 'multiple_requirements');
  const cycle: Record<string, unknown> = {}; cycle.loop = cycle;
  assert.equal(requirementsDiagnostic([{ ...requirements, extra: cycle }], payload({ ...requirements, extra: { loop: {} } })).code, 'requirements_mismatch');
  assert.equal(requirementsDiagnostic([{ ...requirements, extra: cycle }], payload({ ...requirements, extra: { loop: cycle } })).code, 'sdk_match_rejected');
});

test('provider codes are a strict finite allowlist; malformed details never reach a snapshot or report', () => {
  assert.deepEqual(providerDiagnostic('invalid_exact_evm_signature', 400),
    { version: 1, code: 'facilitator_declined', providerCode: 'invalid_exact_evm_signature', providerHttpStatus: 400 });
  assert.equal(providerDiagnostic(null).providerCode, 'missing');
  assert.equal(providerDiagnostic(secret).providerCode, 'unrecognized');
  assert.equal(providerDiagnostic('invalid_exact_evm_signature_' + secret).providerCode, 'unrecognized');
  const safe = sanitizePaymentDiagnostic({ version: 1, code: 'facilitator_declined', providerCode: secret,
    providerHttpStatus: secret, mismatchFields: ['payTo', secret, 'payTo'], response: secret, signature: secret });
  assert.deepEqual(safe, { version: 1, code: 'facilitator_declined', providerCode: 'unrecognized', mismatchFields: ['payTo'] });
  assert.equal(sanitizePaymentDiagnostic({ version: 2, code: secret }), null);
  const t = paymentTelemetry('present', undefined); t.paymentDiagnostic = safe!;
  assert.doesNotMatch(JSON.stringify(paymentSnapshot(t)), /DO-NOT-LOG/);
  assert.equal(explainPaymentDiagnostic('verification_declined', providerDiagnostic(secret)).reviewArea, 'unknown');
  assert.equal(explainPaymentDiagnostic('verification_declined', providerDiagnostic('invalid_exact_evm_missing_eip712_domain')).reviewArea, 'server_configuration');
  assert.equal(explainPaymentDiagnostic('verification_declined', providerDiagnostic('invalid_exact_evm_insufficient_balance')).reviewArea, 'payer_funds_or_allowance');
});

test('unstructured provider HTTP failures retain only the SDK status prefix, never response excerpts', () => {
  for (const [status, area] of [[401, 'server_configuration'], [403, 'server_configuration'], [429, 'provider_or_network'], [503, 'provider_or_network']] as const) {
    const detail = facilitatorExceptionDiagnostic(new Error(`Facilitator verify failed (${status}): ${secret}`));
    assert.equal(detail.providerHttpStatus, status);
    assert.equal(explainPaymentDiagnostic('facilitator_unavailable', detail).reviewArea, area);
    assert.doesNotMatch(JSON.stringify(detail), /DO-NOT-LOG/);
  }
  assert.equal(facilitatorExceptionDiagnostic(new Error(secret)).code, 'facilitator_transport_error');
  assert.equal(facilitatorExceptionDiagnostic(new DOMException(secret, 'TimeoutError')).code, 'facilitator_timeout');
  const configurationError = new Error(secret); configurationError.name = 'RouteConfigurationError';
  assert.equal(facilitatorExceptionDiagnostic(configurationError).code, 'payment_configuration');
});

test('diagnostics survive private archiving, replay and reporting; old and legacy-header counts stay distinct', () => {
  const row = (id: string, extra = {}) => ({ schemaVersion: 2, requestId: id, t: now, method: 'GET', route: '/api/gas',
    status: 402, terminal: 'finish', abortReason: null, paymentHeader: 'payment-signature', protocolVersion: 'v2',
    paymentPhase: 'verify', paymentReason: 'verification_declined', paymentStage: 'rejected', paymentSubmitted: true,
    facilitatorVerifyCalls: 1, facilitatorSettleCalls: 0, facilitatorVerifyMs: 5, facilitatorSettleMs: 0, ...extra });
  const current = row('current', { paymentDiagnostic: { ...providerDiagnostic('invalid_exact_evm_signature', 400), private: secret } });
  const legacy = row('legacy', { paymentHeader: 'x-payment', protocolVersion: 'unknown', paymentPhase: 'parse',
    paymentReason: 'unsupported_version', facilitatorVerifyCalls: 0, paymentDiagnostic: { version: 1, code: 'legacy_header' } });
  const old = row('old');
  const input = [current, legacy, old].map(r => JSON.stringify(r)).join('\n');
  const operations = [current, legacy, old,
    row('health', { route: '/health' }), row('wrong-method', { method: 'POST' })]
    .map(r => JSON.stringify({ ...r, path: r.route, ms: 10 })).join('\n');
  assert.equal(summarizeRequests(operations).paymentDiagnostics.total, 3);
  const archive = updateUsageArchive(null, input, now);
  assert.doesNotMatch(JSON.stringify(archive), /DO-NOT-LOG/);
  const replay = updateUsageArchive(JSON.parse(JSON.stringify(archive.state)), input, now);
  assert.equal(replay.report.failures.total, 2);
  assert.equal(replay.report.paymentDiagnostics.total, 3);
  assert.equal(replay.report.paymentDiagnostics.withDetails, 2);
  assert.equal(replay.report.paymentDiagnostics.withoutDetails, 1);
  assert.deepEqual(replay.report.paymentDiagnostics, summarizeUsageLogs(input).paymentDiagnostics);
  assert.equal(replay.report.settlements.confirmedUnique, 0);
  const conflicted = updateUsageArchive(archive.state, JSON.stringify({ ...current, paymentDiagnostic: providerDiagnostic('insufficient_funds') }), now);
  assert.equal(conflicted.report.input.conflictingRequestIds, 1);
  assert.equal(conflicted.report.paymentDiagnostics.total, 2);
});
