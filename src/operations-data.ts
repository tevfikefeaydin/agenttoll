import { getRadarHistory, getScorecard } from './services/history.js';
import { getTokenSafety } from './services/safety.js';
import { requestContext, withSignal } from './request-context.js';

const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const SCOUT_SCHEDULE_MINUTES = 7 * 60 + 23; // Existing snapshot.yml daily UTC schedule.
type DataCheck = { ok: boolean; status: string; error?: string; ms: number; upstreamCalls: number;
  [key: string]: unknown };
type Loaders = { history: () => Promise<unknown>; scorecard: () => Promise<unknown>; safety: () => Promise<unknown> };
const defaults: Loaders = { history: () => getRadarHistory(), scorecard: () => getScorecard('7'), safety: () => getTokenSafety(USDC) };

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid data response');
  return value as Record<string, unknown>;
}
function count(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error('Invalid coverage');
  return value as number;
}

/** Direct, read-only upstream diagnostics. No payment client, signer or key loading. */
export async function checkDataQuality(options: { now?: number; timeoutMs?: number; maxSnapshotAgeHours?: number } = {}, loaders: Loaders = defaults) {
  const now = options.now ?? Date.now();
  const timeoutMs = options.timeoutMs ?? 25_000;
  const maxAgeHours = options.maxSnapshotAgeHours ?? 30;
  if (!Number.isFinite(now)) throw new Error('Invalid observation time');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) throw new Error('Invalid data check timeout');
  if (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0 || maxAgeHours > 168) throw new Error('Invalid maximum snapshot age');
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new DOMException('Data check deadline', 'TimeoutError')), timeoutMs);
  async function run(name: string, load: () => Promise<unknown>, inspect: (value: Record<string, unknown>) => Omit<DataCheck, 'ms' | 'upstreamCalls'>): Promise<DataCheck> {
    const started = Date.now();
    const context = { requestId: `data-monitor-${name}`, signal: deadline.signal, upstreamCalls: 0,
      cacheHits: 0, cacheMisses: 0, coalescedLoads: 0 };
    try {
      const value = await requestContext.run(context, () => withSignal(Promise.resolve().then(load), deadline.signal));
      return { ...inspect(object(value)), ms: Date.now() - started, upstreamCalls: context.upstreamCalls } as DataCheck;
    } catch {
      return { ok: false, status: 'unavailable', error: deadline.signal.aborted ? 'CHECK_DEADLINE' : 'DATA_UNAVAILABLE',
        ms: Date.now() - started, upstreamCalls: context.upstreamCalls };
    }
  }
  try {
    const [snapshot, scorecard, safety] = await Promise.all([
      run('snapshot', loaders.history, data => {
        const at = typeof data.at === 'string' ? data.at : '';
        const captureTime = Date.parse(at);
        const date = typeof data.date === 'string' ? data.date : '';
        const revision = object(data.provenance).revision;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^[0-9a-f]{40}$/.test(String(revision))) throw new Error('Invalid snapshot identity');
        if (!Number.isFinite(captureTime) || captureTime > now + 60_000 || new Date(captureTime).toISOString().slice(0, 10) !== date) {
          return { ok: false, status: 'unavailable', error: 'INVALID_SNAPSHOT_TIME' };
        }
        const ageSeconds = Math.max(0, Math.floor((now - captureTime) / 1000));
        const captureDelaySeconds = Math.max(0, Math.floor((captureTime - Date.parse(`${date}T00:00:00Z`)) / 1000) - SCOUT_SCHEDULE_MINUTES * 60);
        const summary = object(data.summary);
        const found = count(summary.found), checked = count(summary.checked), unchecked = count(summary.unchecked);
        if (checked + unchecked !== found || !Array.isArray(data.pools) || data.pools.length !== found ||
          data.pools.map(object).filter(pool => pool.safety === null).length !== unchecked) throw new Error('Invalid snapshot coverage');
        const stale = ageSeconds > maxAgeHours * 3600;
        return { ok: !stale, status: stale ? 'stale' : 'fresh', ...(stale ? { error: 'STALE_SNAPSHOT' } : {}),
          date, capturedAt: at, ageSeconds, maxAgeHours, captureDelaySeconds, revision,
          poolsObserved: found, poolsChecked: checked, poolsUnchecked: unchecked };
      }),
      run('scorecard', loaders.scorecard, data => {
        const coverage = object(data.coverage);
        const observed = count(coverage.tokensObserved), priced = count(coverage.tokensPriced);
        const listed = count(coverage.snapshotsListed), loaded = count(coverage.snapshotsLoaded);
        if (priced > observed || loaded > listed || !Array.isArray(data.tokens) || data.tokens.length !== observed) throw new Error('Invalid scorecard coverage');
        const rows = data.tokens.map(object);
        if (rows.some(row => !['priced', 'low-observed-liquidity', 'unavailable'].includes(String(row.outcome))) ||
          rows.filter(row => row.outcome === 'priced').length !== priced) throw new Error('Inconsistent scorecard outcomes');
        const unavailable = rows.filter(row => row.outcome === 'unavailable').length;
        const lowLiquidity = rows.filter(row => row.outcome === 'low-observed-liquidity').length;
        const missingSafety = count(coverage.poolsWithoutSafety);
        const failedBatches = count(coverage.priceBatchesFailed) + count(coverage.fallbackPriceBatchesFailed ?? 0);
        const partial = priced < observed || loaded < listed || missingSafety > 0 || failedBatches > 0;
        return { ok: loaded > 0 && (observed === 0 || unavailable < observed), status: partial ? 'partial' : 'complete',
          snapshotsListed: listed, snapshotsLoaded: loaded, tokensObserved: observed, tokensPriced: priced,
          pricedFraction: observed ? Number((priced / observed).toFixed(4)) : null,
          tokensUnavailable: unavailable, lowObservedLiquidity: lowLiquidity, poolsWithoutSafety: missingSafety, failedPriceBatches: failedBatches };
      }),
      run('safety', loaders.safety, data => {
        const coverage = object(data.coverage);
        const completed = count(coverage.completedChecks), total = count(coverage.totalChecks);
        if (!total || completed > total || !['high-risk', 'caution', 'insufficient-data', 'clear'].includes(String(data.verdict))) throw new Error('Invalid safety coverage');
        return { ok: completed > 0, status: completed === total ? 'complete' : 'partial',
          benchmarkToken: USDC, verdict: data.verdict, completedChecks: completed, totalChecks: total,
          completedFraction: Number((completed / total).toFixed(4)) };
      }),
    ]);
    const checks = { snapshot, scorecard, safety };
    return { schemaVersion: 1, ok: Object.values(checks).every(check => check.ok),
      degraded: Object.values(checks).some(check => !check.ok || check.status === 'partial'),
      checkedAt: new Date(now).toISOString(), checks,
      scope: 'Read-only public upstream data and immutable published snapshot inspection. No payment, signature or wallet key. Partial coverage is distinct from availability; the safety benchmark covers USDC only.' };
  } finally {
    clearTimeout(timer);
    deadline.abort();
  }
}
