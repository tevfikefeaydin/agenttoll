import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { summarizeInspectionLogs } from '../src/inspection-report.js';

const operator = '0x5f871f89b13f5c7f570a765aa54c211323f36f78';
const externalA = '0x' + 'aa'.repeat(20);
const externalB = '0x' + 'bb'.repeat(20);
const externalC = '0x' + 'cc'.repeat(20);
const asset = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const testnetAsset = '0x036cbd53842c5426634e7929541ec2318f3dcf7e';

function row(id: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    schemaVersion: 2,
    t: '2026-09-14T10:00:00.000Z',
    requestId: id,
    method: 'GET',
    path: '/api/base/safety/{address}',
    route: '/api/base/safety/{address}',
    status: 402,
    ms: 10,
    terminal: 'finish',
    abortReason: null,
    client: { name: 'agenttoll-inspect', version: '1.0.0', source: 'x-agenttoll-client' },
    paymentHeader: 'none',
    protocolVersion: 'none',
    paymentPhase: 'parse',
    paymentReason: 'payment_required',
    facilitatorVerifyCalls: 0,
    facilitatorSettleCalls: 0,
    facilitatorVerifyMs: 0,
    facilitatorSettleMs: 0,
    paymentStage: 'quote',
    paymentSubmitted: false,
    verifiedPayer: null,
    settlementTransaction: null,
    upstreamCalls: 0,
    cacheHits: 0,
    cacheMisses: 0,
    coalescedLoads: 0,
    ...extra,
  });
}

function settlement(id: string, payer: string, txByte: string, extra: Record<string, unknown> = {}) {
  return row(id, {
    status: 200,
    paymentHeader: 'payment-signature',
    protocolVersion: 'v2',
    paymentPhase: 'settle',
    paymentReason: null,
    facilitatorVerifyCalls: 1,
    facilitatorSettleCalls: 1,
    paymentStage: 'settled',
    paymentSubmitted: true,
    verifiedPayer: payer,
    settlementTransaction: '0x' + txByte.repeat(32),
    settlementAmount: '3000',
    settlementAsset: asset,
    settlementNetwork: 'eip155:8453',
    ...extra,
  });
}

test('inspection report counts bounded browser usage and exact confirmed USDC without exposing wallets', () => {
  const lines = [
    row('quote-1'),
    row('quote-2', { t: '2026-09-15T09:00:00.000Z' }),
    settlement('operator', operator, '01'),
    settlement('external-a-1', externalA, '02'),
    settlement('external-a-2', externalA, '03', { t: '2026-09-15T11:00:00.000Z' }),
    settlement('external-b-abort', externalB, '04', {
      t: '2026-09-15T12:00:00.000Z', terminal: 'abort', abortReason: 'client_disconnected',
      paymentReason: 'client_disconnected', status: 499,
    }),
    settlement('external-a-duplicate-receipt', externalA, '03', { t: '2026-09-15T11:00:00.000Z' }),
    settlement('testnet-only', externalC, '05', {
      t: '2026-09-15T13:00:00.000Z', settlementAsset: testnetAsset, settlementNetwork: 'eip155:84532',
    }),
    row('declined', { paymentHeader: 'payment-signature', protocolVersion: 'v2', paymentPhase: 'verify',
      paymentReason: 'verification_declined', paymentStage: 'rejected', paymentSubmitted: true,
      facilitatorVerifyCalls: 1 }),
    row('unknown', { status: 504, paymentHeader: 'payment-signature', protocolVersion: 'v2', paymentPhase: 'settle',
      paymentReason: 'request_timeout', paymentStage: 'unknown', paymentSubmitted: true,
      facilitatorVerifyCalls: 1, facilitatorSettleCalls: 1 }),
    row('handler-failed', { status: 502, paymentHeader: 'payment-signature', protocolVersion: 'v2', paymentPhase: 'handler',
      paymentReason: 'handler_failed', paymentStage: 'submitted', paymentSubmitted: true,
      facilitatorVerifyCalls: 1 }),
    row('different-client', { client: { name: 'agenttoll-mcp', version: '0.14.0', source: 'x-agenttoll-client' } }),
    row('different-route', { path: '/api/gas', route: '/api/gas' }),
    row('quote-1'),
    'not json',
  ];

  const report = summarizeInspectionLogs(lines.join('\n'));

  assert.deepEqual(report.window, {
    firstRequestAt: '2026-09-14T10:00:00.000Z',
    lastRequestAt: '2026-09-15T13:00:00.000Z',
    utcDaysObserved: 2,
  });
  assert.deepEqual(report.requests, { quotes: 2, signedSubmissions: 9 });
  assert.deepEqual(report.failures, {
    total: 3,
    byPaymentStage: { rejected: 1, submitted: 1, unknown: 1 },
    byPaymentPhase: { handler: 1, settle: 1, verify: 1 },
    byReason: { handler_failed: 1, request_timeout: 1, verification_declined: 1 },
  });
  assert.equal(report.settlements.confirmedUnique, 4);
  assert.equal(report.settlements.successfullyDeliveredReports, 3);
  assert.equal(report.settlements.settledButAborted, 1);
  assert.equal(report.settlements.duplicateReceiptRecords, 1);
  assert.deepEqual(report.settlements.usdc, {
    totalUnits: '12000', total: '0.012000',
    knownOperatorUnits: '3000', knownOperator: '0.003000',
    externalUnits: '9000', external: '0.009000',
  });
  assert.deepEqual(report.settlements.wallets, { knownOperator: 1, external: 2, returningExternal: 1 });
  assert.deepEqual(report.settlements.excludedTestnet, {
    network: 'eip155:84532',
    confirmedUnique: 1,
    successfullyDeliveredReports: 1,
    settledButAborted: 0,
    usdcUnits: '3000',
    usdc: '0.003000',
    wallets: { knownOperator: 0, external: 1, returningExternal: 0 },
  });
  assert.equal(report.settlements.network, 'eip155:8453');
  assert.equal(report.input.duplicateRequestIds, 1);
  assert.equal(report.input.conflictingRequestIds, 0);
  assert.equal(report.input.conflictingRequestRecords, 0);
  assert.equal(report.input.ignoredLines, 1);
  assert.doesNotMatch(JSON.stringify(report), /5f871f|aaaaaaaa|bbbbbbbb|cccccccc/i);
  assert.equal('conversionRate' in report, false);
});

test('inspection report excludes malformed, legacy, unsupported and conflicting settlement evidence', () => {
  const conflictingTx = '09';
  const report = summarizeInspectionLogs([
    settlement('valid', externalA, '08'),
    settlement('conflict-a', externalA, conflictingTx),
    settlement('conflict-b', externalB, conflictingTx, { settlementAmount: '4000' }),
    settlement('bad-tx', externalA, 'zz'),
    settlement('bad-asset', externalA, '0a', { settlementAsset: '0x' + 'cc'.repeat(20) }),
    settlement('bad-network', externalA, '0b', { settlementNetwork: 'eip155:1' }),
    settlement('missing-server-requirements', externalA, '0c', { settlementAmount: undefined }),
    settlement('oversized-amount', externalA, '0f', { settlementAmount: '1'.repeat(79) }),
    row('legacy', { schemaVersion: 1, status: 200, paymentStage: 'settled', paymentSubmitted: true,
      paymentHeader: 'payment-signature', protocolVersion: 'v2', settlementTransaction: '0x' + '0d'.repeat(32),
      verifiedPayer: externalA, settlementAmount: '3000', settlementAsset: asset, settlementNetwork: 'eip155:8453' }),
    settlement('fake-state', externalA, '0e', { paymentSubmitted: false }),
    settlement('request-conflict', externalA, '11'),
    settlement('request-conflict', externalA, '12', { status: 999 }),
  ].join('\n'));

  assert.equal(report.settlements.confirmedUnique, 1);
  assert.equal(report.settlements.usdc.totalUnits, '3000');
  assert.deepEqual(report.settlements.unresolved, {
    totalRecords: 9,
    malformedReceiptRecords: 1,
    unsupportedAssetRecords: 1,
    unsupportedNetworkRecords: 1,
    legacyOrInconsistentRecords: 4,
    conflictingReceipts: 1,
    conflictingReceiptRecords: 2,
  });
  assert.equal(report.settlements.duplicateReceiptRecords, 0);
  assert.equal(report.input.duplicateRequestIds, 0);
  assert.equal(report.input.conflictingRequestIds, 1);
  assert.equal(report.input.conflictingRequestRecords, 2);
  assert.doesNotMatch(JSON.stringify(report), /aaaaaaaa|bbbbbbbb|cccccccc/i);
});

test('receipt replay on a later UTC day cannot make returning wallets depend on export order', () => {
  const firstReceipt = settlement('first-receipt', externalA, '20', { t: '2026-09-14T08:00:00.000Z' });
  const replaySeenLater = settlement('replay-later', externalA, '21', { t: '2026-09-15T08:00:00.000Z' });
  const sameReceiptSeenEarlier = settlement('replay-earlier', externalA, '21', { t: '2026-09-14T09:00:00.000Z' });

  for (const input of [
    [firstReceipt, replaySeenLater, sameReceiptSeenEarlier],
    [sameReceiptSeenEarlier, replaySeenLater, firstReceipt],
  ]) {
    const report = summarizeInspectionLogs(input.join('\n'));
    assert.equal(report.settlements.confirmedUnique, 2);
    assert.equal(report.settlements.duplicateReceiptRecords, 1);
    assert.equal(report.settlements.wallets.returningExternal, 0);
  }
});

test('inspection CLI accepts repeated bounded inputs and emits the aggregate as JSON', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'agenttoll-inspections-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const first = join(directory, 'one.ndjson');
  const second = join(directory, 'two.ndjson');
  writeFileSync(first, row('quote'));
  writeFileSync(second, settlement('paid', externalA, '10'));
  const run = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/inspection-report.mjs', '--input', first, '--input', second,
    '--exclude-operator', externalA], {
    cwd: process.cwd(), encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.deepEqual(report.requests, { quotes: 1, signedSubmissions: 1 });
  assert.equal(report.settlements.confirmedUnique, 1);
  assert.equal(report.settlements.usdc.total, '0.003000');
  assert.deepEqual(report.settlements.wallets, { knownOperator: 1, external: 0, returningExternal: 0 });
  assert.throws(() => summarizeInspectionLogs('', ['not-an-address']), /20-byte addresses/);
});
