import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as usage from '../src/usage-report.js';
import { summarizeInspectionLogs } from '../src/inspection-report.js';
import { KNOWN_OPERATOR_WALLETS } from '../src/operator-wallets.js';

type Row = Record<string, unknown>;
const external = '0x' + 'ab'.repeat(20);
const extraOperator = '0x' + 'cd'.repeat(20);
const asset = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const testnet = { settlementNetwork: 'eip155:84532', settlementAsset: '0x036cbd53842c5426634e7929541ec2318f3dcf7e' };
const noReceipt = { verifiedPayer: null, settlementTransaction: null, settlementAmount: null,
  settlementAsset: null, settlementNetwork: null, facilitatorSettleCalls: 0 };
function receipt(id: number, extra: Row = {}): Row {
  return { schemaVersion: 2, requestId: `stream-${id}`, t: '2026-09-14T10:00:00Z',
    method: 'GET', route: '/api/gas', path: '/api/gas', client: null,
    status: 200, terminal: 'finish', abortReason: null, paymentHeader: 'payment-signature',
    protocolVersion: 'v2', paymentPhase: 'settle', paymentReason: null,
    facilitatorVerifyCalls: 1, facilitatorSettleCalls: 1, facilitatorVerifyMs: 2, facilitatorSettleMs: 2,
    paymentStage: 'settled', paymentSubmitted: true, verifiedPayer: external,
    settlementTransaction: '0x' + id.toString(16).padStart(64, '0'), settlementAmount: '1000',
    settlementAsset: asset, settlementNetwork: 'eip155:8453', ...extra };
}

function compare(rows: Row[], operators: readonly string[] = []) {
  const lines = rows.map(row => JSON.stringify(row));
  const expected = usage.summarizeUsageLogs(lines.join('\n'), operators);
  assert.deepEqual(usage.summarizeUsageLogs(lines, operators), expected);
  let iterations = 0;
  const once = {
    *[Symbol.iterator]() {
      assert.equal(++iterations, 1, 'row input must only be traversed once');
      yield* rows;
    },
  };
  assert.equal(typeof usage.summarizeUsageRows, 'function', 'row reporting API must be exported');
  assert.deepEqual(usage.summarizeUsageRows(once, operators), expected);
  assert.equal(iterations, 1);
  assert.deepEqual(usage.summarizeUsageRows(rows, operators), expected);
  return expected;
}

test('row input preserves operator, testnet, canonical endpoint and UTC breakdowns', () => {
  const report = compare([
    receipt(1),
    receipt(2, { route: `/api/base/safety/${external}`, settlementAmount: '3000', t: '2026-09-15T11:00:00Z' }),
    receipt(3, { verifiedPayer: [...KNOWN_OPERATOR_WALLETS][0] }),
    receipt(4, { verifiedPayer: extraOperator, t: '2026-09-21T00:00:00Z' }),
    receipt(5, { ...testnet }), receipt(6, { ...testnet, verifiedPayer: extraOperator }),
    receipt(7, { ...testnet, t: '2026-09-15T00:00:00Z' }),
    receipt(8, { route: '/api/health' }), receipt(9, { route: '/api/not-registered' }),
  ], [extraOperator.toUpperCase().replace('0X', '0x')]);
  assert.equal(report.settlements.confirmedUnique, 4);
  assert.deepEqual(report.settlements.wallets, { external: 1, knownOperator: 2, returningExternal: 1 });
  assert.equal(report.settlements.usdc.external, '0.004000');
  assert.equal(report.settlements.usdc.knownOperator, '0.002000');
  assert.equal(report.settlements.excludedTestnet.confirmedUnique, 3);
  assert.deepEqual(report.settlements.excludedTestnet.wallets, { external: 1, knownOperator: 1, returningExternal: 1 });
  assert.equal(report.byEndpoint.find(row => row.route === '/api/base/safety/{address}')?.external.usdc, '0.003000');
  assert.equal(report.daily.find(row => row.date === '2026-09-21')?.knownOperator.wallets, 1);
  assert.doesNotMatch(JSON.stringify(report), new RegExp(`${external}|${extraOperator}`));
});

test('raw differences in discarded fields still exclude every conflicting request record', () => {
  const report = compare([
    receipt(1, { debug: { discarded: 'a' } }), receipt(1, { debug: { discarded: 'a' } }),
    receipt(1, { debug: { discarded: 'b' } }), receipt(1, { debug: { discarded: 'c' } }),
    receipt(2, { route: '/not-paid' }), receipt(2),
    receipt(3), receipt(3, { status: 999 }),
    receipt(4, { route: '/not-paid', debug: 'a' }), receipt(4, { route: '/not-paid', debug: 'b' }),
    receipt(5), receipt(5),
    receipt(6, { debug: { a: 1, b: 2 } }), receipt(6, { debug: { b: 2, a: 1 } }),
  ]);
  assert.deepEqual(report.input, { totalLines: 14, matchingRecords: 1, duplicateRequestIds: 1,
    conflictingRequestIds: 4, conflictingRequestRecords: 10, ignoredLines: 0 });
  assert.equal(report.settlements.confirmedUnique, 1);
  assert.equal(report.requests.signedSubmissions, 1);
});

test('amount, route, payer and delivery conflicts remain receipt conflicts across request IDs', () => {
  const report = compare([
    receipt(1), receipt(1, { requestId: 'amount-conflict', settlementAmount: '2000' }),
    receipt(2), receipt(2, { requestId: 'route-conflict', route: '/api/price/BTC' }),
    receipt(3), receipt(3, { requestId: 'payer-conflict', verifiedPayer: extraOperator }),
    receipt(4), receipt(4, { requestId: 'delivery-conflict', status: 499, terminal: 'abort',
      abortReason: 'request_timeout', paymentReason: 'request_timeout' }),
  ]);
  assert.equal(report.settlements.confirmedUnique, 0);
  assert.equal(report.settlements.unresolved.conflictingReceipts, 4);
  assert.equal(report.settlements.unresolved.conflictingReceiptRecords, 8);
  assert.equal(report.settlements.unresolved.totalRecords, 8);
  assert.equal(report.requests.signedSubmissions, 8);
  assert.equal(report.settlements.duplicateReceiptRecords, 0);
});

test('overlapping exports preserve earliest receipt dates and consecutive-week wallet overlap', () => {
  const rows = [receipt(1, { requestId: 'later-observation', t: '2026-09-15T10:00:00Z' }),
    receipt(1), receipt(1), receipt(2, { t: '2026-09-21T00:00:00Z' }),
    receipt(3, { t: '2026-10-05T00:00:00Z' })];
  const report = compare(rows);
  assert.deepEqual(compare([...rows].reverse()), report);
  assert.equal(report.input.duplicateRequestIds, 1);
  assert.equal(report.settlements.duplicateReceiptRecords, 1);
  assert.equal(report.settlements.confirmedUnique, 3);
  assert.equal(report.daily.find(row => row.date === '2026-09-15')?.external.settlements, 0);
  assert.deepEqual(report.weekly.map(row => row.returningFromPreviousWeek), [0, 1, 0]);
  const duplicateOnly = compare(rows.slice(0, 3));
  assert.equal(duplicateOnly.settlements.wallets.returningExternal, 0);
});

test('row input preserves validation, quote and failure counters without inventing settlement', () => {
  const report = compare([
    receipt(1, { ...noReceipt, status: 402, paymentStage: 'quote', paymentSubmitted: false,
      paymentHeader: 'none', protocolVersion: 'none', paymentPhase: 'parse', paymentReason: 'payment_required', facilitatorVerifyCalls: 0 }),
    receipt(2, { ...noReceipt, status: 402, paymentStage: 'rejected', paymentPhase: 'verify', paymentReason: 'verification_declined' }),
    receipt(3, { settlementConfirmed: false }), receipt(4, { settlementAmount: '1.5' }),
    receipt(5, { schemaVersion: 1 }), receipt(6, { settlementTransaction: 'bad' }),
    receipt(7, { settlementAsset: extraOperator }), receipt(8, { settlementNetwork: 'eip155:1' }),
    receipt(9, { status: 499, terminal: 'abort', abortReason: 'client_disconnected', paymentReason: 'client_disconnected' }),
    receipt(10, { t: 'not-a-date' }), receipt(11, { method: 'POST' }), receipt(12, { requestId: 'invalid id' }),
    receipt(13, { ...noReceipt, schemaVersion: 1, status: 402, paymentStage: 'quote', t: '2026-09-13T10:00:00Z' }),
  ]);
  assert.equal(report.input.matchingRecords, 10);
  assert.deepEqual(report.requests, { quotes: 1, signedSubmissions: 7 });
  assert.deepEqual(report.failures, { total: 1, byPaymentStage: { rejected: 1 },
    byPaymentPhase: { verify: 1 }, byReason: { verification_declined: 1 } });
  assert.deepEqual(report.settlements.unresolved, { totalRecords: 6, malformedReceiptRecords: 1,
    unsupportedAssetRecords: 1, unsupportedNetworkRecords: 1, legacyOrInconsistentRecords: 3,
    conflictingReceipts: 0, conflictingReceiptRecords: 0 });
  assert.equal(report.settlements.confirmedUnique, 1);
  assert.equal(report.settlements.settledButAborted, 1);
  assert.equal(report.window.firstRequestAt, '2026-09-13T10:00:00.000Z');
});

test('log wrappers preserve blank, CRLF, wrapped, malformed and oversized line handling', () => {
  const valid = receipt(1);
  const wrapped = JSON.stringify({ message: JSON.stringify(valid) });
  const chunks = ['', '  \r\n' + JSON.stringify(valid) + '\r', '\n' + wrapped,
    'not json\r\nnull\n[]\n{"message":"invalid"}\n' + JSON.stringify({ padding: 'x'.repeat(65_536) }),
    JSON.stringify(receipt(2, { requestId: 'invalid id' })), ''];
  const report = usage.summarizeUsageLogs(chunks);
  assert.deepEqual(usage.summarizeUsageLogs(chunks.join('\n')), report);
  const rowsReport = compare([valid, valid, receipt(2, { requestId: 'invalid id' })]);
  assert.deepEqual(report, { ...rowsReport, input: { ...rowsReport.input, totalLines: 8, ignoredLines: 5 } });
  const boundary = JSON.stringify(valid) + ' '.repeat(65_536 - JSON.stringify(valid).length);
  assert.equal(usage.summarizeUsageLogs(boundary).input.matchingRecords, 1);
  assert.equal(usage.summarizeUsageLogs(boundary + '\r').input.ignoredLines, 1);
  assert.equal(usage.summarizeUsageLogs([boundary + '\r', '']).input.matchingRecords, 1);
  const inspect = { ...valid, route: '/api/base/safety/{address}',
    client: { name: 'agenttoll-inspect', version: '1.0.0', source: 'x-agenttoll-client' } };
  const inspection = summarizeInspectionLogs([JSON.stringify(inspect), JSON.stringify(valid), JSON.stringify(inspect)]);
  assert.equal(inspection.input.matchingRecords, 0);
  assert.equal(inspection.input.conflictingRequestIds, 1);
  assert.equal(inspection.input.conflictingRequestRecords, 3);
});

test('row reporting snapshots a one-pass producer that reuses its record object', () => {
  const expected = compare([receipt(1), receipt(2, { settlementAmount: '3000', t: '2026-09-21T00:00:00Z' })]);
  function* reused() {
    const row = receipt(1);
    yield row;
    Object.assign(row, receipt(2, { settlementAmount: '3000', t: '2026-09-21T00:00:00Z' }));
    yield row;
    row.settlementAmount = '999999';
  }
  assert.deepEqual(usage.summarizeUsageRows(reused()), expected);
});

test('empty row input and invalid operator options preserve the wrapper contract', () => {
  const empty = compare([]);
  assert.equal(empty.input.totalLines, 0);
  assert.equal(empty.window.firstRequestAt, null);
  assert.deepEqual(empty.daily, []);
  function* untouched(): Generator<Row> { assert.fail('invalid options must fail before reading input'); }
  for (const operators of [['bad'], Array<string>(129).fill(external)]) {
    const message = operators.length > 128 ? /At most 128/ : /20-byte addresses/;
    assert.throws(() => usage.summarizeUsageLogs('', operators), message);
    assert.throws(() => usage.summarizeUsageRows(untouched(), operators), message);
  }
});

test('one-pass reporting fits a bounded heap even when discarded metadata exceeds it', () => {
  // About 344 MiB of distinct raw metadata must not survive in rows or fingerprints.
  // Keep the memory bound in a separate process so the test runner's heap is unaffected.
  const moduleUrl = new URL('../src/usage-report.ts', import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import { summarizeUsageRows } from ${JSON.stringify(moduleUrl)};
    const base = ${JSON.stringify(receipt(1))};
    function* rows() {
      for (let i = 0; i < 6000; i++) yield {
        ...base, requestId: 'bounded-' + i, debug: 'x'.repeat(60000) + i,
      };
    }
    const report = summarizeUsageRows(rows());
    assert.equal(report.input.matchingRecords, 6000);
    assert.equal(report.settlements.confirmedUnique, 1);
    assert.equal(report.settlements.duplicateReceiptRecords, 5999);
  `;
  const result = spawnSync(process.execPath, ['--max-old-space-size=192', '--import', 'tsx',
    '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
});
