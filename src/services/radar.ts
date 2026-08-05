import { cached } from "./cache.js";
import { fetchJsonRetrying, fromSources } from "./sources.js";
import { optionalInt, optionalNumber } from "./params.js";

interface NewPool {
  attributes: {
    name: string;
    address: string;
    pool_created_at: string;
    base_token_price_usd: string;
    volume_usd: { h24: string };
    reserve_in_usd: string;
  };
  relationships?: { base_token?: { data?: { id?: string } } };
}

/** GeckoTerminal ids look like "base_0xabc…"; callers want the bare address. */
const tokenAddress = (pool: NewPool): string | null => {
  const id = pool.relationships?.base_token?.data?.id;
  const addr = id?.replace(/^base_/, "").toLowerCase();
  return addr && /^0x[0-9a-f]{40}$/.test(addr) ? addr : null;
};

/** The provider page as we cache it: every fresh pool, no caller filters yet. */
interface RadarData {
  chain: string;
  pools: {
    name: string;
    pool: string;
    /** The new token itself — pass it to /api/base/safety before touching it. */
    token: string | null;
    createdAt: string;
    priceUsd: number;
    volume24hUsd: number;
    liquidityUsd: number;
  }[];
  source: string;
  at: string;
}

/** What a caller gets back: their floor applied, and the count that survived. */
interface Radar extends RadarData {
  minLiquidityUsd: number;
  count: number;
}

// New token radar: pools created on Base in the last ~24h that already carry
// real liquidity. The liquidity floor filters out the worst of the spam;
// callers can raise or lower it per call.
const DEFAULT_MIN_LIQUIDITY_USD = 10_000;
const DEFAULT_LIMIT = 15;
const DAY_MS = 24 * 60 * 60 * 1000;

async function fetchPools(path: string): Promise<NewPool[]> {
  const json = (await fetchJsonRetrying(
    `https://api.geckoterminal.com/api/v2/networks/base/${path}`,
    { headers: { Accept: "application/json" } },
  )) as { data?: NewPool[] };
  if (!json.data?.length) throw new Error("empty response");
  return json.data;
}

function shape(data: NewPool[], source: string, freshOnly: boolean): RadarData {
  const cutoff = Date.now() - DAY_MS;
  const pools = data
    .map((p) => ({
      name: p.attributes.name,
      pool: p.attributes.address,
      token: tokenAddress(p),
      createdAt: p.attributes.pool_created_at,
      priceUsd: Number(p.attributes.base_token_price_usd),
      volume24hUsd: Number(p.attributes.volume_usd?.h24 ?? 0),
      liquidityUsd: Number(p.attributes.reserve_in_usd ?? 0),
    }))
    // The volume listing spans all pools, so it needs the age filter applied.
    .filter((p) => !freshOnly || Date.parse(p.createdAt) >= cutoff)
    .sort((a, b) => b.volume24hUsd - a.volume24hUsd);
  // The caller's floor is applied later, per request. This one is a health
  // check on the source itself: a page with nothing but dust is how the new
  // pools listing looks when it is degraded, and that is worth failing over.
  if (!pools.some((p) => p.liquidityUsd >= DEFAULT_MIN_LIQUIDITY_USD)) {
    throw new Error("no pools cleared the liquidity floor");
  }
  return { chain: "base", pools, source, at: new Date().toISOString() };
}

/**
 * New pools on Base, newest-and-busiest first.
 *
 * `minLiquidity` sets the spam floor in USD (default $10,000) and `limit` caps
 * the list (default 15). The provider response is cached whole, so both knobs
 * are free: a wider or narrower request never costs an extra upstream call.
 */
export async function getNewTokenRadar(
  minLiquidityRaw?: string,
  limitRaw?: string,
): Promise<Radar> {
  const minLiquidityUsd =
    optionalNumber("minLiquidity", minLiquidityRaw, { min: 0, max: 1_000_000_000 }) ??
    DEFAULT_MIN_LIQUIDITY_USD;
  const limit = optionalInt("limit", limitRaw, { min: 1, max: 30 }) ?? DEFAULT_LIMIT;

  // Longer TTL than the market feeds: new pools move slowly and this is the
  // endpoint most exposed to the provider's rate limit.
  const data = await cached("radar", 300_000, () =>
    fromSources<RadarData>("base new-token radar", [
      {
        name: "geckoterminal-new-pools",
        load: async () => {
          // Sequential, not parallel: two simultaneous calls are twice as
          // likely to trip the per-minute limit.
          const first = await fetchPools("new_pools?page=1");
          const second = await fetchPools("new_pools?page=2").catch(() => []);
          return shape([...first, ...second], "geckoterminal-new-pools", false);
        },
      },
      {
        // Degraded path: the top-volume listing, narrowed to pools born today.
        name: "geckoterminal-volume",
        load: async () =>
          shape(await fetchPools("pools?sort=h24_volume_usd_desc&page=1"), "geckoterminal-recent-volume", true),
      },
    ]),
  );

  const pools = data.pools.filter((p) => p.liquidityUsd >= minLiquidityUsd).slice(0, limit);
  return { ...data, minLiquidityUsd, count: pools.length, pools };
}
