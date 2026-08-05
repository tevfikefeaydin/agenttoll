import { cached } from "./cache.js";
import { fetchJsonRetrying, fromSources } from "./sources.js";

interface NewPool {
  attributes: {
    name: string;
    address: string;
    pool_created_at: string;
    base_token_price_usd: string;
    volume_usd: { h24: string };
    reserve_in_usd: string;
  };
}

interface Radar {
  chain: string;
  minLiquidityUsd: number;
  pools: {
    name: string;
    pool: string;
    createdAt: string;
    priceUsd: number;
    volume24hUsd: number;
    liquidityUsd: number;
  }[];
  source: string;
  at: string;
}

// New token radar: pools created on Base in the last ~24h that already carry
// real liquidity. The liquidity floor filters out the worst of the spam.
const MIN_LIQUIDITY_USD = 10_000;
const DAY_MS = 24 * 60 * 60 * 1000;

async function fetchPools(path: string): Promise<NewPool[]> {
  const json = (await fetchJsonRetrying(
    `https://api.geckoterminal.com/api/v2/networks/base/${path}`,
    { headers: { Accept: "application/json" } },
  )) as { data?: NewPool[] };
  if (!json.data?.length) throw new Error("empty response");
  return json.data;
}

function shape(data: NewPool[], source: string, freshOnly: boolean): Radar {
  const cutoff = Date.now() - DAY_MS;
  const pools = data
    .map(({ attributes: a }) => ({
      name: a.name,
      pool: a.address,
      createdAt: a.pool_created_at,
      priceUsd: Number(a.base_token_price_usd),
      volume24hUsd: Number(a.volume_usd?.h24 ?? 0),
      liquidityUsd: Number(a.reserve_in_usd ?? 0),
    }))
    .filter((p) => p.liquidityUsd >= MIN_LIQUIDITY_USD)
    // The volume listing spans all pools, so it needs the age filter applied.
    .filter((p) => !freshOnly || Date.parse(p.createdAt) >= cutoff)
    .sort((a, b) => b.volume24hUsd - a.volume24hUsd)
    .slice(0, 15);
  if (!pools.length) throw new Error("no pools cleared the liquidity floor");
  return { chain: "base", minLiquidityUsd: MIN_LIQUIDITY_USD, pools, source, at: new Date().toISOString() };
}

export async function getNewTokenRadar() {
  // Longer TTL than the market feeds: new pools move slowly and this is the
  // endpoint most exposed to the provider's rate limit.
  return cached("radar", 300_000, () =>
    fromSources<Radar>("base new-token radar", [
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
}
