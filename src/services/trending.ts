interface TrendingCoin {
  item: {
    id: string;
    symbol: string;
    name: string;
    market_cap_rank: number | null;
    data?: { price?: number; price_change_percentage_24h?: { usd?: number } };
  };
}

export async function getTrending() {
  const res = await fetch("https://api.coingecko.com/api/v3/search/trending");
  if (!res.ok) throw new Error(`Upstream trending source returned ${res.status}`);
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
    at: new Date().toISOString(),
  };
}
