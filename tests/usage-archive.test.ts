import test from 'node:test';
import assert from 'node:assert/strict';
import { updateUsageArchive } from '../src/usage-archive.js';
const now = '2026-09-26T12:00:00.000Z';
const row = (extra = {}) => JSON.stringify({ schemaVersion: 2, requestId: 'one', t: now,
 method: 'GET', route: '/api/gas', status: 200, terminal: 'finish', abortReason: null,
 paymentHeader: 'payment-signature', protocolVersion: 'v2', paymentPhase: 'settle', paymentReason: null,
 facilitatorVerifyCalls: 1, facilitatorSettleCalls: 1, facilitatorVerifyMs: 1, facilitatorSettleMs: 1,
 paymentStage: 'settled', paymentSubmitted: true, verifiedPayer: '0x' + 'ab'.repeat(20),
 settlementTransaction: '0x' + '12'.repeat(32), settlementAmount: '1000',
 settlementAsset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', settlementNetwork: 'eip155:8453', ...extra });
test('archive survives restart and overlapping replay without inflating usage', () => {
 const first = updateUsageArchive(null, row(), now);
 const next = updateUsageArchive(JSON.parse(JSON.stringify(first.state)), row() + '\n' + row(), now);
 assert.equal(next.report.settlements.confirmedUnique, 1);
 assert.equal(next.state.entries.length, 1);
 assert.equal(next.report.requests.signedSubmissions, 1);
});
test('conflicts persist across runs, including differences in discarded fields', () => {
 const first = updateUsageArchive(null, row({ secret: 'never-persist-this' }), now);
 assert.doesNotMatch(JSON.stringify(first), /never-persist-this|"secret"/);
 const second = updateUsageArchive(first.state, row({ secret: 'different' }), now);
 const third = updateUsageArchive(second.state, row({ secret: 'never-persist-this' }), now);
 assert.equal(third.report.settlements.confirmedUnique, 0);
 assert.equal(third.report.input.conflictingRequestIds, 1);
});
test('archive is bounded, expires records, rejects corrupt state and clock rollback', () => {
 const first = updateUsageArchive(null, row(), now);
 assert.throws(() => updateUsageArchive({ ...first.state, entries: [{}] }, '', now));
 assert.throws(() => updateUsageArchive(first.state, '', '2026-09-25T00:00:00.000Z'));
 assert.throws(() => updateUsageArchive(null, 'x'.repeat(20 * 1024 * 1024 + 1), now));
 const later = updateUsageArchive(first.state, '', '2026-11-26T12:00:00.000Z');
 assert.equal(later.state.entries.length, 0);
 assert.equal(later.report.coverage.complete, false);
 assert.equal(later.report.coverage.delayedCollection, true);
});
test('malformed fields cannot become valid receipts or leak secrets', () => {
 const result = updateUsageArchive(null, row({ settlementAmount: 'secret-amount', paymentReason: 'secret-reason', route: '/api/gas?token=secret-query' }), now);
 assert.equal(result.report.settlements.confirmedUnique, 0);
 assert.doesNotMatch(JSON.stringify(result), /secret-amount|secret-reason|secret-query/);
});

test('unsigned successful health probes do not exhaust paid usage retention', () => {
 const input = Array.from({ length: 40000 }, (_, i) => row({ requestId: `health-${i}`, route: '/api/health',
  paymentHeader: 'none', paymentSubmitted: false, paymentStage: 'none', verifiedPayer: null,
  settlementTransaction: null, settlementAmount: null, settlementAsset: null, settlementNetwork: null })).join('\n');
 // Exercise batches within the input limit, as the collector does.
 const lines = input.split('\n');
 const first = updateUsageArchive(null, lines.slice(0, 20000).join('\n'), now);
 const next = updateUsageArchive(first.state, lines.slice(20000).join('\n') + '\n' + row(), now);
 assert.equal(next.state.entries.length, 1);
 assert.equal(next.report.settlements.confirmedUnique, 1);
});

test('coverage reports retained observation dates separately from collection start', () => {
 const observed = '2026-08-28T12:00:00.000Z';
 const first = updateUsageArchive(null, row({ t: observed }), now);
 assert.equal(first.report.coverage.retainedSince, observed);
 assert.equal(first.report.coverage.collectionStartedAt, now);
 const later = updateUsageArchive(first.state, '', '2026-10-25T12:00:00.000Z');
 assert.equal(later.report.coverage.retainedSince, observed);
});

test('archive rejects impossible collection dates and does not date malformed observations', () => {
 assert.throws(() => updateUsageArchive(null, '', '2026-02-30T12:00:00.000Z'));
 const result = updateUsageArchive(null, row({ t: '2026-09-31T12:00:00.000Z' }), '2026-10-02T12:00:00.000Z');
 assert.equal(result.report.settlements.confirmedUnique, 0);
 assert.equal(result.report.coverage.retainedSince, null);
});
