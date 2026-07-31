import { cached, fetchWithTimeout } from "./cache.js";

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

// New token radar: pools created on Base in the last ~24h that already carry
// real liquidity. The liquidity floor filters out the worst of the spam.
const MIN_LIQUIDITY_USD = 10_000;

export async function getNewTokenRadar() {
  return cached("radar", 120_000, async () => {
    const pages = await Promise.all(
      [1, 2].map(async (p) => {
        const res = await fetchWithTimeout(
          `https://api.geckoterminal.com/api/v2/networks/base/new_pools?page=${p}`,
          { headers: { Accept: "application/json" } },
        );
        if (!res.ok) throw new Error(`Upstream radar source returned ${res.status}`);
        return ((await res.json()) as { data: NewPool[] }).data;
      }),
    );
    const pools = pages
      .flat()
      .map(({ attributes: a }) => ({
        name: a.name,
        pool: a.address,
        createdAt: a.pool_created_at,
        priceUsd: Number(a.base_token_price_usd),
        volume24hUsd: Number(a.volume_usd?.h24 ?? 0),
        liquidityUsd: Number(a.reserve_in_usd ?? 0),
      }))
      .filter((p) => p.liquidityUsd >= MIN_LIQUIDITY_USD)
      .sort((a, b) => b.volume24hUsd - a.volume24hUsd)
      .slice(0, 15);
    return {
      chain: "base",
      minLiquidityUsd: MIN_LIQUIDITY_USD,
      pools,
      at: new Date().toISOString(),
    };
  });
}
