import { cached, fetchWithTimeout } from "./cache.js";
import { badRequest } from "./errors.js";
import { optionalInt } from "./params.js";

/**
 * The track record: what the radar flagged on past days, and what those
 * tokens are worth now.
 *
 * Snapshots live as dated JSON files in the public GitHub repo, committed by
 * a daily CI run — served from raw.githubusercontent.com here so the API and
 * the audit trail are literally the same bytes. Each snapshot carries the
 * Base tx that paid for it, so even "when was this really taken" is provable.
 */

const RAW = "https://raw.githubusercontent.com/tevfikefeaydin/agenttoll/main/data/scout";
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

async function rawJson<T>(path: string): Promise<T | null> {
  const res = await fetchWithTimeout(`${RAW}/${path}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Snapshot store returned ${res.status}`);
  return (await res.json()) as T;
}

const listDates = () =>
  cached("history:index", 600_000, async () => {
    const idx = await rawJson<{ dates: string[] }>("index.json");
    return idx?.dates ?? [];
  });

const getSnapshot = (date: string) =>
  cached(`history:${date}`, 6 * 3_600_000, () => rawJson<Snapshot>(`${date}.json`));

/** One day's snapshot, exactly as it was committed — plus its provenance. */
export async function getRadarHistory(dateRaw?: string) {
  const dates = await listDates();
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

  const snap = await getSnapshot(date);
  if (!snap) throw new Error("Snapshot listed but unreachable — please retry");
  return {
    chain: "base",
    ...snap,
    provenance: {
      commit: `https://github.com/tevfikefeaydin/agenttoll/commits/main/data/scout/${date}.json`,
      raw: `${RAW}/${date}.json`,
      paidWith: snap.settlement ? `https://basescan.org/tx/${snap.settlement}` : null,
    },
    availableDates: { first: dates[0], last: dates[dates.length - 1], count: dates.length },
  };
}

// ---------------------------------------------------------------------------

/** Current prices for a set of tokens, one batched request. */
async function currentPrices(tokens: string[]): Promise<Map<string, { priceUsd: number; liquidityUsd: number }>> {
  const out = new Map<string, { priceUsd: number; liquidityUsd: number }>();
  // DexScreener batches 30 addresses per call and reports pairs, not tokens;
  // keep the deepest pool per token so a dust pair can't misprice it.
  for (let i = 0; i < tokens.length; i += 30) {
    const batch = tokens.slice(i, i + 30);
    const res = await fetchWithTimeout(`https://api.dexscreener.com/tokens/v1/base/${batch.join(",")}`);
    if (!res.ok) throw new Error(`Price source returned ${res.status}`);
    const pairs = (await res.json()) as {
      baseToken?: { address?: string };
      priceUsd?: string;
      liquidity?: { usd?: number };
    }[];
    for (const p of Array.isArray(pairs) ? pairs : []) {
      const addr = p.baseToken?.address?.toLowerCase();
      const price = Number(p.priceUsd);
      const liq = Number(p.liquidity?.usd ?? 0);
      if (!addr || !Number.isFinite(price)) continue;
      const prev = out.get(addr);
      if (!prev || liq > prev.liquidityUsd) out.set(addr, { priceUsd: price, liquidityUsd: liq });
    }
  }
  return out;
}

/**
 * The scorecard: every token the radar surfaced in the window, grouped by the
 * verdict it got THEN, valued at what it trades for NOW. The honest version
 * of "we called it" — including the days we didn't.
 */
export async function getScorecard(daysRaw?: string) {
  const days = optionalInt("days", daysRaw, { min: 1, max: 30 }) ?? 7;

  return cached(`scorecard:${days}`, 1_800_000, async () => {
    const dates = await listDates();
    if (!dates.length) throw new Error("No snapshots are published yet — history begins " + HISTORY_BEGINS);
    const window = dates.slice(-days);

    // Fetched together, read in order: the window grows a file a day, and
    // walking them one request at a time would make a month-long scorecard
    // thirty round trips deep. Promise.all keeps the order, which is what the
    // first-sighting rule below depends on.
    const snapshots = await Promise.all(window.map(getSnapshot));

    // First sighting wins: a token seen on day 1 and day 3 is judged from day 1.
    const seen = new Map<string, { date: string; name: string; verdict: string; thenPriceUsd: number; thenLiquidityUsd: number }>();
    for (const [i, snap] of snapshots.entries()) {
      const date = window[i];
      for (const pool of snap?.pools ?? []) {
        if (!pool.token || !pool.safety || seen.has(pool.token)) continue;
        seen.set(pool.token, {
          date,
          name: pool.name,
          verdict: pool.safety.verdict,
          thenPriceUsd: pool.priceUsd,
          thenLiquidityUsd: pool.liquidityUsd,
        });
      }
    }

    const tokens = [...seen.keys()];
    const now = tokens.length ? await currentPrices(tokens) : new Map();

    const entries = tokens.map((token) => {
      const then = seen.get(token)!;
      const cur = now.get(token);
      // No tradeable pair left is an outcome, not a data gap: for a token the
      // radar saw with five figures of liquidity days ago, it usually means
      // the liquidity is gone.
      const gone = !cur || cur.liquidityUsd < 100;
      const changePct =
        !gone && then.thenPriceUsd > 0 ? ((cur!.priceUsd - then.thenPriceUsd) / then.thenPriceUsd) * 100 : null;
      return {
        token,
        name: then.name,
        flaggedOn: then.date,
        verdictThen: then.verdict,
        liquidityThenUsd: Math.round(then.thenLiquidityUsd),
        liquidityNowUsd: cur ? Math.round(cur.liquidityUsd) : 0,
        priceChangePct: changePct === null ? null : Number(changePct.toFixed(1)),
        liquidityGone: gone,
      };
    });

    const cohort = (verdict: string) => {
      const rows = entries.filter((e) => e.verdictThen === verdict);
      const priced = rows.filter((e) => e.priceChangePct !== null);
      return {
        count: rows.length,
        liquidityGone: rows.filter((e) => e.liquidityGone).length,
        medianChangePct: priced.length
          ? Number(priced.map((e) => e.priceChangePct!).sort((a, b) => a - b)[Math.floor(priced.length / 2)].toFixed(1))
          : null,
      };
    };

    return {
      chain: "base",
      windowDays: days,
      trackRecord: { daysCovered: window.length, firstSnapshot: dates[0], lastSnapshot: dates[dates.length - 1] },
      cohorts: {
        "high-risk": cohort("high-risk"),
        caution: cohort("caution"),
        "insufficient-data": cohort("insufficient-data"),
        clear: cohort("clear"),
      },
      tokens: entries.sort((a, b) => (a.priceChangePct ?? -101) - (b.priceChangePct ?? -101)),
      methodology:
        "Each token is judged from its FIRST appearance in the window: verdict and price then, deepest-pool price and liquidity now. liquidityGone means no pair holds even $100 anymore. Snapshots are dated git commits; verify any row yourself via /api/base/radar/history.",
      disclaimer:
        "A track record, not investment advice. Cohort medians over small counts are noisy — read the per-token rows.",
      at: new Date().toISOString(),
    };
  });
}
