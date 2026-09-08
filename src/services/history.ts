import { cached, fetchWithTimeout } from "./cache.js";
import { badRequest } from "./errors.js";
import { optionalInt } from "./params.js";
import { requestContext } from "../request-context.js";

/**
 * The track record: what the radar flagged on past days, and what those
 * tokens are worth now.
 *
 * Snapshots live as dated JSON files in the public GitHub repo, committed by
 * a daily CI run. Each read pins the index and snapshots to one immutable
 * repository revision. A settlement proves a payment, not the snapshot's
 * content or capture time; historical files did not commit content hashes.
 */

const REPOSITORY = "tevfikefeaydin/agenttoll";
const rawRoot = (revision: string) => `https://raw.githubusercontent.com/${REPOSITORY}/${revision}/data/scout`;
const HISTORY_BEGINS = "2026-08-06";

interface SnapshotPool {
  name: string;
  pool: string;
  token: string | null;
  createdAt: string;
  priceUsd: number;
  liquidityUsd: number;
  volume24hUsd: number;
  safety: { verdict: string; failed: string[]; warnings: string[]; unchecked: string[] } | null;
}

interface Snapshot {
  date: string;
  at: string;
  settlement: string | null;
  summary: Record<string, number>;
  pools: SnapshotPool[];
}

async function rawJson<T>(revision: string, path: string): Promise<T | null> {
  const res = await fetchWithTimeout(`${rawRoot(revision)}/${path}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Snapshot store returned ${res.status}`);
  return (await res.json()) as T;
}

const listDates = () =>
  cached("history:index", 600_000, async () => {
    const res = await fetchWithTimeout(`https://api.github.com/repos/${REPOSITORY}/commits/main`, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) throw new Error(`Cannot resolve immutable history revision: HTTP ${res.status}`);
    const commit = (await res.json()) as { sha?: string };
    if (typeof commit.sha !== "string" || !/^[0-9a-f]{40}$/.test(commit.sha)) throw new Error("Invalid immutable history revision");
    const idx = await rawJson<{ dates: string[] }>(commit.sha, "index.json");
    if (idx && (!Array.isArray(idx.dates) || idx.dates.some((date) => !/^\d{4}-\d{2}-\d{2}$/.test(date)))) throw new Error("Invalid snapshot index");
    return { revision: commit.sha, dates: [...new Set(idx?.dates ?? [])].sort() };
  });

const getSnapshot = (revision: string, date: string) =>
  cached(`history:${revision}:${date}`, 6 * 3_600_000, async () => {
    const snap = await rawJson<Snapshot>(revision, `${date}.json`);
    if (snap && (snap.date !== date || !Array.isArray(snap.pools))) throw new Error("Invalid snapshot content");
    return snap;
  });

const integrity = "Git revision pins the published bytes. A payment transaction does not authenticate a snapshot hash or its capture time.";

/** One day's snapshot, exactly as it was committed — plus its provenance. */
export async function getRadarHistory(dateRaw?: string) {
  const { dates, revision } = await listDates();
  if (!dates.length) throw new Error("No snapshots are published yet — history begins " + HISTORY_BEGINS);

  let date = dates[dates.length - 1];
  if (dateRaw !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateRaw)) {
      badRequest("Invalid 'date' — expected YYYY-MM-DD");
    }
    if (!dates.includes(dateRaw)) {
      badRequest(`No snapshot for ${dateRaw}. Available: ${dates[0]} .. ${dates[dates.length - 1]} (${dates.length} days)`);
    }
    date = dateRaw;
  }

  const snap = await getSnapshot(revision, date);
  if (!snap) throw new Error("Snapshot listed but unreachable — please retry");
  return {
    chain: "base",
    ...snap,
    provenance: {
      revision,
      commit: `https://github.com/${REPOSITORY}/commit/${revision}`,
      raw: `${rawRoot(revision)}/${date}.json`,
      paidWith: snap.settlement ? `https://basescan.org/tx/${snap.settlement}` : null,
      integrity,
    },
    availableDates: { first: dates[0], last: dates[dates.length - 1], count: dates.length },
  };
}

// ---------------------------------------------------------------------------

/** Current prices for a set of tokens, one batched request. */
interface CurrentPrice { priceUsd: number | null; liquidityUsd: number | null }

const positive = (value: unknown): number | null => {
  const n = typeof value === "number" || (typeof value === "string" && value.trim()) ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};
const liquidity = (value: unknown): number | null => {
  const n = typeof value === "number" || (typeof value === "string" && value.trim()) ? Number(value) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
};

async function currentPrices(tokens: string[]) {
  const out = new Map<string, CurrentPrice>();
  let failedBatches = 0;
  // DexScreener batches 30 addresses per call and reports pairs, not tokens;
  // keep the deepest pool per token so a dust pair can't misprice it.
  for (let i = 0; i < tokens.length; i += 30) {
    const batch = tokens.slice(i, i + 30);
    let pairs: {
      chainId?: string;
      baseToken?: { address?: string };
      priceUsd?: string;
      liquidity?: { usd?: number };
    }[];
    try {
      const res = await fetchWithTimeout(`https://api.dexscreener.com/tokens/v1/base/${batch.join(",")}`);
      if (!res.ok) throw new Error(`Price source returned ${res.status}`);
      pairs = await res.json();
      if (!Array.isArray(pairs)) throw new Error("Invalid price source response");
    } catch {
      requestContext.getStore()?.signal.throwIfAborted();
      failedBatches++;
      continue;
    }
    for (const p of pairs) {
      if (!p || typeof p !== "object" || typeof p.baseToken?.address !== "string") continue;
      const addr = p.baseToken.address.toLowerCase();
      const price = positive(p.priceUsd);
      const liq = liquidity(p.liquidity?.usd);
      if (!addr || !batch.includes(addr) || (p.chainId && p.chainId !== "base")) continue;
      const prev = out.get(addr);
      if (!prev || (liq ?? -1) > (prev.liquidityUsd ?? -1)) out.set(addr, { priceUsd: price, liquidityUsd: liq });
    }
  }
  return { prices: out, failedBatches };
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return Number((sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2).toFixed(1));
}

/**
 * The scorecard: every token the radar surfaced in the window, grouped by the
 * verdict it got THEN, valued at what it trades for NOW. The honest version
 * of "we called it" — including the days we didn't.
 */
export async function getScorecard(daysRaw?: string) {
  const days = optionalInt("days", daysRaw, { min: 1, max: 30 }) ?? 7;

  const { dates, revision } = await listDates();
  return cached(`scorecard:${revision}:${days}`, 1_800_000, async () => {
    if (!dates.length) throw new Error("No snapshots are published yet — history begins " + HISTORY_BEGINS);
    const window = dates.slice(-days);

    // Fetched together, read in order: the window grows a file a day, and
    // walking them one request at a time would make a month-long scorecard
    // thirty round trips deep. Promise.all keeps the order, which is what the
    // first-sighting rule below depends on.
    const snapshots = await Promise.all(window.map((date) => getSnapshot(revision, date).catch(() => {
      requestContext.getStore()?.signal.throwIfAborted();
      return null;
    })));
    const missingSnapshotDates = window.filter((_, i) => snapshots[i] === null);
    let poolsObserved = 0;
    let poolsWithoutSafety = 0;
    let poolsWithoutToken = 0;

    // First sighting wins: a token seen on day 1 and day 3 is judged from day 1.
    const seen = new Map<string, { date: string; name: string; verdict: string; thenPriceUsd: number; thenLiquidityUsd: number }>();
    for (const [i, snap] of snapshots.entries()) {
      const date = window[i];
      for (const pool of snap?.pools ?? []) {
        poolsObserved++;
        if (!pool.safety) poolsWithoutSafety++;
        if (!pool.token || !/^0x[0-9a-fA-F]{40}$/.test(pool.token)) { poolsWithoutToken++; continue; }
        const token = pool.token.toLowerCase();
        if (seen.has(token)) continue;
        seen.set(token, {
          date,
          name: pool.name,
          verdict: pool.safety?.verdict ?? "unassessed",
          thenPriceUsd: pool.priceUsd,
          thenLiquidityUsd: pool.liquidityUsd,
        });
      }
    }

    const tokens = [...seen.keys()];
    const now = await currentPrices(tokens);

    const changes = new Map<string, number | null>();
    const entries = tokens.map((token) => {
      const then = seen.get(token)!;
      const cur = now.prices.get(token);
      // Absence from a price index is not evidence that liquidity disappeared.
      // The threshold describes only the deepest observed provider pair.
      const gone = cur?.liquidityUsd == null ? null : cur.liquidityUsd < 100;
      const changePct =
        gone === false && cur?.priceUsd != null && positive(then.thenPriceUsd) !== null
          ? ((cur.priceUsd - then.thenPriceUsd) / then.thenPriceUsd) * 100 : null;
      const measuredChange = changePct !== null && Number.isFinite(changePct) ? changePct : null;
      changes.set(token, measuredChange);
      return {
        token,
        name: then.name,
        flaggedOn: then.date,
        verdictThen: then.verdict,
        liquidityThenUsd: liquidity(then.thenLiquidityUsd) === null ? null : Math.round(then.thenLiquidityUsd),
        liquidityNowUsd: cur?.liquidityUsd == null ? null : Math.round(cur.liquidityUsd),
        priceChangePct: measuredChange === null ? null : Number(measuredChange.toFixed(1)),
        liquidityGone: gone,
        outcome: gone === true ? "low-observed-liquidity" : measuredChange === null ? "unavailable" : "priced",
      };
    });

    const cohort = (verdict: string) => {
      const rows = entries.filter((e) => e.verdictThen === verdict);
      const priced = rows.filter((e) => e.priceChangePct !== null);
      return {
        count: rows.length,
        priced: priced.length,
        unavailable: rows.filter((e) => e.outcome === "unavailable").length,
        liquidityGone: rows.filter((e) => e.liquidityGone === true).length,
        medianChangePct: median(priced.map((e) => changes.get(e.token)!)),
      };
    };

    return {
      chain: "base",
      windowDays: days,
      trackRecord: { daysCovered: snapshots.filter(Boolean).length, firstSnapshot: dates[0], lastSnapshot: dates[dates.length - 1] },
      coverage: {
        requestedDays: days,
        windowBasis: "latest-published-snapshots",
        snapshotsListed: window.length,
        snapshotsLoaded: snapshots.filter(Boolean).length,
        missingSnapshotDates,
        windowFirstSnapshot: window[0],
        windowLastSnapshot: window[window.length - 1],
        poolsObserved, poolsWithoutSafety, poolsWithoutToken,
        tokensObserved: entries.length,
        tokensPriced: entries.filter((e) => e.priceChangePct !== null).length,
        priceBatchesFailed: now.failedBatches,
        complete: false,
        note: "Snapshot cohorts are selected radar samples, not all Base launches. Missing snapshots, missing safety checks and unavailable quotes are reported separately; elapsed holding periods vary by first sighting.",
      },
      provenance: { revision, commit: `https://github.com/${REPOSITORY}/commit/${revision}`, index: `${rawRoot(revision)}/index.json`, integrity },
      cohorts: {
        "high-risk": cohort("high-risk"),
        caution: cohort("caution"),
        "insufficient-data": cohort("insufficient-data"),
        clear: cohort("clear"),
        unassessed: cohort("unassessed"),
      },
      tokens: entries.sort((a, b) => (a.priceChangePct ?? -101) - (b.priceChangePct ?? -101)),
      methodology:
        "Each token is judged from its FIRST appearance in the available window: verdict and price then, deepest observed provider-pair price and liquidity now. liquidityGone=true means observed liquidity below $100, false means at least $100, null means unavailable. Missing pairs are not losses. Medians include only priced rows and use variable holding periods; snapshots are samples pinned to the stated git revision.",
      disclaimer:
        "A track record, not investment advice. Cohort medians over small counts are noisy — read the per-token rows.",
      at: new Date().toISOString(),
    };
  });
}
