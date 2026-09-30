import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { summarizeUsageLogs } from '../src/usage-report.js';

const external = '0x' + 'ab'.repeat(20);
const operator = '0x5f871f89b13f5c7f570a765aa54c211323f36f78';
function receipt(id: number, extra: Record<string, unknown> = {}) {
  return JSON.stringify({ schemaVersion: 2, requestId: `usage-${id}`, t: '2026-09-14T10:00:00Z',
    method: 'GET', route: '/api/gas', path: '/api/gas', client: null,
    status: 200, terminal: 'finish', abortReason: null, paymentHeader: 'payment-signature',
    protocolVersion: 'v2', paymentPhase: 'settle', paymentReason: null,
    facilitatorVerifyCalls: 1, facilitatorSettleCalls: 1, facilitatorVerifyMs: 2, facilitatorSettleMs: 2,
    paymentStage: 'settled', paymentSubmitted: true, verifiedPayer: external,
    settlementTransaction: '0x' + id.toString(16).padStart(64, '0'), settlementAmount: '1000',
    settlementAsset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', settlementNetwork: 'eip155:8453',
    ...extra });
}

test('usage report covers paid clients, separates operators, and attributes deduplicated revenue', () => {
  const data = [receipt(1), receipt(2, { route: '/api/base/safety/{address}', settlementAmount: '3000',
    t: '2026-09-15T11:00:00Z', client: { name: 'agenttoll-inspect', version: '1.0.0', source: 'x-agenttoll-client' } }),
    receipt(3, { verifiedPayer: operator }), receipt(1),
    receipt(4, { route: '/api/health' }), receipt(5, { route: '/api/not-registered' })];
  const report = summarizeUsageLogs(data);
  assert.equal(report.settlements.confirmedUnique, 3);
  assert.equal(report.settlements.usdc.external, '0.004000');
  assert.equal(report.settlements.usdc.knownOperator, '0.001000');
  assert.deepEqual(report.settlements.wallets, { external: 1, knownOperator: 1, returningExternal: 1 });
  assert.equal(report.input.duplicateRequestIds, 1);
  assert.equal(report.daily.length, 2);
  assert.equal(report.daily[0].external.settlements, 1);
  assert.equal(report.daily[0].knownOperator.usdc, '0.001000');
  assert.equal(report.daily[1].external.usdc, '0.003000');
  assert.equal(report.byEndpoint.find(row => row.route === '/api/gas')?.external.usdc, '0.001000');
  assert.doesNotMatch(JSON.stringify(report), new RegExp(`${external}|${operator}|${'0x' + '1'.padStart(64, '0')}`));
});

test('usage report excludes testnet, inconsistent receipts and cross-endpoint transaction conflicts', () => {
  const report = summarizeUsageLogs([
    receipt(1), receipt(1, { requestId: 'other-route', route: '/api/price/BTC' }),
    receipt(2, { settlementNetwork: 'eip155:84532', settlementAsset: '0x036cbd53842c5426634e7929541ec2318f3dcf7e' }),
    receipt(3, { settlementConfirmed: false }), receipt(4, { settlementAmount: '1.5' }),
    receipt(5, { status: 499, terminal: 'abort', abortReason: 'client_disconnected', paymentReason: 'client_disconnected' }),
  ]);
  assert.equal(report.settlements.confirmedUnique, 1);
  assert.equal(report.settlements.settledButAborted, 1);
  assert.equal(report.settlements.successfullyDeliveredReports, 0);
  assert.equal(report.settlements.excludedTestnet.confirmedUnique, 1);
  assert.equal(report.settlements.unresolved.conflictingReceipts, 1);
  assert.equal(report.settlements.unresolved.totalRecords, 4);
  assert.equal(report.byEndpoint[0].external.settledButAborted, 1);
});

test('returning wallets require distinct receipt days and weekly overlap uses consecutive UTC weeks', () => {
  const report = summarizeUsageLogs([
    receipt(1), receipt(1, { requestId: 'duplicate-later', t: '2026-09-15T10:00:00Z' }),
    receipt(2, { t: '2026-09-21T00:00:00Z' }),
    receipt(3, { t: '2026-10-05T00:00:00Z' }),
  ]);
  assert.equal(report.settlements.confirmedUnique, 3);
  assert.equal(report.daily.filter(row => row.external.settlements > 0).length, 3);
  assert.equal(report.daily.find(row => row.date === '2026-09-15')?.external.settlements, 0);
  assert.equal(report.weekly[0].weekStarting, '2026-09-14');
  assert.equal(report.weekly[0].returningFromPreviousWeek, 0);
  assert.equal(report.weekly[1].returningFromPreviousWeek, 1);
  assert.equal(report.weekly[2].returningFromPreviousWeek, 0);
  const duplicateOnly = summarizeUsageLogs([receipt(1), receipt(1, { requestId: 'duplicate-later', t: '2026-09-15T10:00:00Z' })]);
  assert.equal(duplicateOnly.settlements.wallets.returningExternal, 0);
});

test('quotes and signed failures do not become revenue and remain visible by endpoint', () => {
  const noReceipt = { verifiedPayer: null, settlementTransaction: null, settlementAmount: null,
    settlementAsset: null, settlementNetwork: null, facilitatorSettleCalls: 0 };
  const report = summarizeUsageLogs([
    receipt(1, { ...noReceipt, status: 402, paymentStage: 'quote', paymentSubmitted: false,
      paymentHeader: 'none', protocolVersion: 'none', paymentPhase: 'parse', paymentReason: 'payment_required', facilitatorVerifyCalls: 0 }),
    receipt(2, { ...noReceipt, status: 402, paymentStage: 'rejected', paymentPhase: 'verify', paymentReason: 'verification_declined' }),
  ]);
  assert.deepEqual(report.requests, { quotes: 1, signedSubmissions: 1 });
  assert.equal(report.failures.total, 1);
  assert.equal(report.settlements.usdc.total, '0.000000');
  assert.equal(report.byEndpoint[0].quotes, 1);
  assert.equal(report.byEndpoint[0].signedFailures, 1);
  assert.equal(report.daily[0].external.wallets, 0);
});

test('conflicting request IDs are excluded across exports and operator overrides apply throughout', () => {
  const report = summarizeUsageLogs([receipt(1), receipt(1, { settlementAmount: '2000' }), receipt(2)], [external]);
  assert.equal(report.input.conflictingRequestIds, 1);
  assert.equal(report.settlements.confirmedUnique, 1);
  assert.equal(report.settlements.wallets.external, 0);
  assert.equal(report.daily[0].knownOperator.wallets, 1);
  assert.equal(report.weekly[0].external.wallets, 0);
});

test('usage CLI accepts bounded overlapping exports and fails on empty or invalid input', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'agenttoll-usage-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'requests.ndjson');
  writeFileSync(file, receipt(1));
  const run = (...args: string[]) => spawnSync(process.execPath,
    ['--import', 'tsx', 'scripts/usage-report.mjs', ...args], { encoding: 'utf8' });
  const result = run('--input', file, '--input', file);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).settlements.confirmedUnique, 1);
  const text = run('--input', file, '--format', 'markdown');
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /0\.001000/);
  assert.doesNotMatch(text.stdout, new RegExp(external));
  assert.notEqual(run('--input', file, '--format', 'html').status, 0);
  assert.notEqual(run('--input', directory).status, 0);
  assert.notEqual(run('--input', file, '--exclude-operator', 'bad').status, 0);
  writeFileSync(file, 'not a request');
  assert.notEqual(run('--input', file).status, 0);
});
