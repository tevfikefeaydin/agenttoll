import { cached } from "./cache.js";
import { fetchJsonRetrying, fromSources } from "./sources.js";
import { optionalInt } from "./params.js";

interface Pool {
  attributes: {
    name: string;
    address: string;
    base_token_price_usd: string;
    volume_usd: { h24: string };
    price_change_percentage: { h24: string };
    reserve_in_usd: string;
  };
}

interface BaseTrending {
  chain: string;
  pools: {
    name: string;
    pool: string;
    priceUsd: number;
    volume24hUsd: number;
    change24hPct: number;
    liquidityUsd: number;
  }[];
  source: string;
  at: string;
}

const DEFAULT_LIMIT = 10;

const shape = (data: Pool[], source: string): BaseTrending => ({
  chain: "base",
  pools: data.map(({ attributes: a }) => ({
    name: a.name,
    pool: a.address,
    priceUsd: Number(a.base_token_price_usd),
    volume24hUsd: Number(a.volume_usd?.h24 ?? 0),
    change24hPct: Number(a.price_change_percentage?.h24 ?? 0),
    liquidityUsd: Number(a.reserve_in_usd ?? 0),
  })),
  source,
  at: new Date().toISOString(),
});

async function pools(path: string): Promise<Pool[]> {
  const json = (await fetchJsonRetrying(
    `https://api.geckoterminal.com/api/v2/networks/base/${path}`,
    { headers: { Accept: "application/json" } },
  )) as { data?: Pool[] };
  if (!json.data?.length) throw new Error("empty response");
  return json.data;
}

// Trending DEX pools on Base. The fallback is the same provider's top-by-volume
// listing — it covers this endpoint failing on its own, not the provider being
// down, so `source` says which ranking produced the answer.
//
// The provider's page is cached whole and `limit` slices it per caller, so a
// wider request costs no extra upstream call.
export async function getBaseTrending(limitRaw?: string): Promise<BaseTrending> {
  const limit = optionalInt("limit", limitRaw, { min: 1, max: 20 }) ?? DEFAULT_LIMIT;
  const data = await cached("basetrending", 60_000, () =>
    fromSources<BaseTrending>("base trending pools", [
      { name: "geckoterminal-trending", load: async () => shape(await pools("trending_pools"), "geckoterminal-trending") },
      {
        name: "geckoterminal-volume",
        load: async () =>
          shape(await pools("pools?sort=h24_volume_usd_desc&page=1"), "geckoterminal-top-volume"),
      },
    ]),
  );
  return { ...data, pools: data.pools.slice(0, limit) };
}
