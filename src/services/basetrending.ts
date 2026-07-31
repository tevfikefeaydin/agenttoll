import { cached, fetchWithTimeout } from "./cache.js";

interface TrendingPool {
  attributes: {
    name: string;
    address: string;
    base_token_price_usd: string;
    volume_usd: { h24: string };
    price_change_percentage: { h24: string };
    reserve_in_usd: string;
  };
}

// Trending DEX pools on Base right now, via GeckoTerminal.
export async function getBaseTrending() {
  return cached("basetrending", 60_000, async () => {
    const res = await fetchWithTimeout(
      "https://api.geckoterminal.com/api/v2/networks/base/trending_pools",
      { headers: { Accept: "application/json" } },
    );
    if (!res.ok) throw new Error(`Upstream trending source returned ${res.status}`);
    const json = (await res.json()) as { data: TrendingPool[] };
    return {
      chain: "base",
      pools: json.data.slice(0, 10).map(({ attributes: a }) => ({
        name: a.name,
        pool: a.address,
        priceUsd: Number(a.base_token_price_usd),
        volume24hUsd: Number(a.volume_usd?.h24 ?? 0),
        change24hPct: Number(a.price_change_percentage?.h24 ?? 0),
        liquidityUsd: Number(a.reserve_in_usd ?? 0),
      })),
      at: new Date().toISOString(),
    };
  });
}
