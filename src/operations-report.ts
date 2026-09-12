import { canonicalRoute } from './telemetry.js';

type Row = Record<string, unknown>;
const counterNames = ['upstreamCalls', 'cacheHits', 'cacheMisses', 'coalescedLoads'] as const;
const stages = new Set(['none', 'quote', 'submitted', 'settled', 'rejected', 'unknown']);
const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

function parseRow(line: string): Row | null {
  if (line.length > 65_536) return null;
  try {
    let row = JSON.parse(line);
    // Vercel CLI/drain exports can wrap the application JSON in a message.
    if (typeof row?.message === 'string') row = JSON.parse(row.message);
    if (!row || typeof row !== 'object' ||
      typeof row.requestId !== 'string' || !/^[\w-]{1,128}$/.test(row.requestId) ||
      typeof row.t !== 'string' || !Number.isFinite(Date.parse(row.t)) ||
      typeof row.path !== 'string' || row.path.length > 8_192 ||
      !['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(row.method) ||
      !Number.isInteger(row.status) || row.status < 100 || row.status > 599 || !nonnegative(row.ms) ||
      !counterNames.every(name => row[name] === undefined || (nonnegative(row[name]) && Number.isSafeInteger(row[name])))) return null;
    if (row.schemaVersion === 1) {
      if (!stages.has(row.paymentStage) || typeof row.paymentSubmitted !== 'boolean') return null;
      if (row.paymentStage === 'settled' && !(row.paymentSubmitted && row.status >= 200 && row.status < 300)) return null;
      if (row.paymentStage === 'quote' && (row.paymentSubmitted || row.status !== 402)) return null;
      if (row.paymentStage === 'rejected' && (!row.paymentSubmitted || row.status !== 402)) return null;
      if (['submitted', 'unknown'].includes(row.paymentStage) && !row.paymentSubmitted) return null;
    }
    return row;
  } catch { return null; }
}

function latency(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p: number) => sorted.length ? sorted[Math.ceil(p * sorted.length) - 1] : null;
  return { p50: percentile(0.5), p95: percentile(0.95), max: sorted.at(-1) ?? null };
}

/** Summarize supplied application logs only; no network, wallets or inferred revenue. */
export function summarizeRequests(text: string) {
  const ids = new Set<string>();
  const rows: Row[] = [];
  let ignoredLines = 0;
  let duplicates = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const row = parseRow(line);
    if (!row) { ignoredLines++; continue; }
    if (ids.has(row.requestId as string)) { duplicates++; continue; }
    ids.add(row.requestId as string);
    rows.push(row);
  }
  const payment = { quotes: 0, submitted: 0, settled: 0, rejected: 0, unknown: 0, legacyUnclassified: 0 };
  const statuses: Record<string, number> = {};
  const routeRows = new Map<string, Row[]>();
  const counters = { upstreamCalls: 0, cacheHits: 0, cacheMisses: 0, coalescedLoads: 0 };
  const times: number[] = [];
  for (const row of rows) {
    const status = String(row.status);
    statuses[status] = (statuses[status] ?? 0) + 1;
    const route = canonicalRoute(row.path as string);
    const group = routeRows.get(route) ?? [];
    group.push(row); routeRows.set(route, group);
    times.push(Date.parse(row.t as string));
    for (const name of counterNames) counters[name] += (row[name] as number | undefined) ?? 0;
    if (row.schemaVersion !== 1) { payment.legacyUnclassified++; continue; }
    if (row.paymentSubmitted) payment.submitted++;
    if (row.paymentStage === 'quote') payment.quotes++;
    if (row.paymentStage === 'settled') payment.settled++;
    if (row.paymentStage === 'rejected') payment.rejected++;
    if (row.paymentStage === 'unknown') payment.unknown++;
  }
  times.sort((a, b) => a - b);
  const serverErrors = rows.filter(row => Number(row.status) >= 500).length;
  return {
    schemaVersion: 1,
    scope: 'Supplied log records only; retention, sampling and missing requests cannot be inferred.',
    window: { firstRequestAt: times.length ? new Date(times[0]).toISOString() : null,
      lastRequestAt: times.length ? new Date(times[times.length - 1]).toISOString() : null },
    requests: rows.length, duplicates, ignoredLines, statuses, serverErrors,
    serverErrorRate: rows.length ? serverErrors / rows.length : null,
    payment, latencyMs: latency(rows.map(row => row.ms as number)), ...counters,
    routes: [...routeRows].map(([route, group]) => ({ route, requests: group.length,
      serverErrors: group.filter(row => Number(row.status) >= 500).length,
      latencyMs: latency(group.map(row => row.ms as number)),
    })).sort((a, b) => b.requests - a.requests || a.route.localeCompare(b.route)),
    notes: [
      '402 is a payment challenge or rejection, not a server failure.',
      'Quote requests and signed retries are separate HTTP requests; no user conversion rate is inferred.',
      'Legacy payment stages are ambiguous and excluded from verified payment outcome counts.',
      'Settlement responses do not measure unique customers, organic demand or net revenue.',
      'Upstream/cache counters describe instrumented data loads; they exclude facilitator calls.',
    ],
  };
}
