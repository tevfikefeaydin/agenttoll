import test from 'node:test';
import assert from 'node:assert/strict';
import { checkDataQuality } from '../src/operations-data.js';
import { requestContext } from '../src/request-context.js';

const now = Date.parse('2026-09-14T16:00:00Z');
const loaders = (at = '2026-09-14T07:25:00Z') => ({
  history: async () => ({ date: at.slice(0, 10), at,
    provenance: { revision: 'a'.repeat(40) }, availableDates: { count: 40 },
    pools: Array.from({ length: 4 }, (_, i) => ({ safety: i < 3 ? { verdict: 'caution' } : null })),
    summary: { found: 4, checked: 3, unchecked: 1 } }),
  scorecard: async () => ({ coverage: { tokensObserved: 26, tokensPriced: 11,
    snapshotsListed: 7, snapshotsLoaded: 7, missingSnapshotDates: [], poolsWithoutSafety: 4,
    priceBatchesFailed: 0, fallbackPriceBatchesFailed: 0 },
    tokens: Array.from({ length: 26 }, (_, i) => ({ outcome: i < 11 ? 'priced' : 'low-observed-liquidity' })) }),
  safety: async () => ({ verdict: 'caution', coverage: { completedChecks: 5, totalChecks: 8, complete: false },
    sourceStatus: { goplus: { status: 'ok' }, 'blockscout+rpc': { status: 'unavailable' } } }),
});

test('data monitor exposes actual capture age and partial coverage separately from availability', async () => {
  const report = await checkDataQuality({ now }, loaders());
  assert.equal(report.ok, true);
  assert.equal(report.degraded, true);
  assert.equal(report.checks.snapshot.ageSeconds, 30_900);
  assert.equal(report.checks.snapshot.captureDelaySeconds, 120);
  assert.equal(report.checks.scorecard.tokensPriced, 11);
  assert.equal(report.checks.scorecard.tokensUnavailable, 0);
  assert.equal(report.checks.scorecard.lowObservedLiquidity, 15);
  assert.equal(report.checks.safety.completedChecks, 5);
  assert.match(report.scope, /No payment/);
});

test('successful service responses do not hide stale or impossible future snapshots', async () => {
  for (const at of ['2026-09-12T14:16:00Z', '2026-09-14T17:00:00Z']) {
    const report = await checkDataQuality({ now }, loaders(at));
    assert.equal(report.ok, false);
    assert.equal(report.checks.snapshot.ok, false);
    assert.ok(['STALE_SNAPSHOT', 'INVALID_SNAPSHOT_TIME'].includes(report.checks.snapshot.error!));
  }
});

test('data monitor bounds a hung provider and never exposes raw diagnostics or secrets', async () => {
  const fixture = loaders();
  let aborted = false;
  fixture.history = async () => {
    const signal = requestContext.getStore()!.signal;
    signal.addEventListener('abort', () => { aborted = true; }, { once: true });
    return new Promise(() => {});
  };
  fixture.safety = async () => { throw new Error('secret-token PRIVATE-WALLET diagnostic'); };
  const report = await checkDataQuality({ now, timeoutMs: 100 }, fixture);
  assert.equal(report.ok, false);
  assert.equal(report.checks.snapshot.error, 'CHECK_DEADLINE');
  assert.equal(report.checks.safety.error, 'DATA_UNAVAILABLE');
  assert.equal(aborted, true);
  assert.doesNotMatch(JSON.stringify(report), /secret-token|PRIVATE-WALLET|diagnostic/);
});

test('data monitor rejects invalid configuration before invoking sources', async () => {
  let called = false;
  const fixture = loaders();
  fixture.history = async () => { called = true; return loaders().history(); };
  await assert.rejects(checkDataQuality({ now, timeoutMs: Infinity }, fixture), /timeout/i);
  await assert.rejects(checkDataQuality({ now, maxSnapshotAgeHours: -1 }, fixture), /age/i);
  assert.equal(called, false);
});

test('inconsistent row and summary counts cannot be reported as healthy coverage', async () => {
  const fixture = loaders();
  fixture.history = async () => ({ ...await loaders().history(), pools: [] });
  fixture.scorecard = async () => ({ ...await loaders().scorecard(),
    tokens: Array.from({ length: 26 }, () => ({ outcome: 'unavailable' })) });
  const report = await checkDataQuality({ now }, fixture);
  assert.equal(report.checks.snapshot.ok, false);
  assert.equal(report.checks.snapshot.error, 'DATA_UNAVAILABLE');
  assert.equal(report.checks.scorecard.ok, false);
  assert.equal(report.checks.scorecard.status, 'unavailable');
});
