import { cached, fetchWithTimeout } from "./cache.js";
import { fromSources } from "./sources.js";
import { optionalInt } from "./params.js";

interface TrendingCoin {
  item: {
    id: string;
    symbol: string;
    name: string;
    market_cap_rank: number | null;
    data?: { price?: number; price_change_percentage_24h?: { usd?: number } };
  };
}

interface Trending {
  coins: {
    id: string;
    symbol: string;
    name: string;
    rank: number | null;
    usd: number | null;
    change24h: number | null;
  }[];
  source: string;
  at: string;
}

/**
 * Tokens trending right now. `limit` trims the list for agents that only want
 * the top few — the upstream call is cached whole either way, so asking for
 * fewer costs the same and hits no extra rate limit.
 */
export async function getTrending(limitRaw?: string): Promise<Trending> {
  const limit = optionalInt("limit", limitRaw, { min: 1, max: 25 });
  const data = await cached("trending", 60_000, () =>
    fromSources<Trending>("trending tokens", [
      { name: "coingecko", load: fromCoinGecko },
      { name: "binance", load: fromBinance },
    ]),
  );
  return limit === undefined ? data : { ...data, coins: data.coins.slice(0, limit) };
}

async function fromCoinGecko(): Promise<Trending> {
  const res = await fetchWithTimeout("https://api.coingecko.com/api/v3/search/trending");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { coins: TrendingCoin[] };
  return {
    coins: data.coins.map(({ item }) => ({
      id: item.id,
      symbol: item.symbol,
      name: item.name,
      rank: item.market_cap_rank,
      usd: item.data?.price ?? null,
      change24h: item.data?.price_change_percentage_24h?.usd ?? null,
    })),
    source: "coingecko",
    at: new Date().toISOString(),
  };
}

/**
 * Degraded stand-in when CoinGecko is unavailable: the liquid USDT pairs that
 * moved the most in 24h. It is search-interest on CoinGecko versus price action
 * here, so the `source` field tells callers which definition they got.
 */
async function fromBinance(): Promise<Trending> {
  const res = await fetchWithTimeout("https://api.binance.com/api/v3/ticker/24hr");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const all = (await res.json()) as {
    symbol: string;
    lastPrice: string;
    priceChangePercent: string;
    quoteVolume: string;
  }[];
  const coins = all
    .filter((t) => t.symbol.endsWith("USDT") && Number(t.quoteVolume) > 5_000_000)
    .sort((a, b) => Math.abs(Number(b.priceChangePercent)) - Math.abs(Number(a.priceChangePercent)))
    .slice(0, 7)
    .map((t) => {
      const symbol = t.symbol.replace(/USDT$/, "");
      return {
        id: symbol.toLowerCase(),
        symbol: symbol.toLowerCase(),
        name: symbol,
        rank: null,
        usd: Number(t.lastPrice),
        change24h: Number(t.priceChangePercent),
      };
    });
  if (!coins.length) throw new Error("no liquid movers in response");
  return { coins, source: "binance-movers", at: new Date().toISOString() };
}
