// Maps common ticker symbols to CoinGecko ids; unknown symbols are passed
// through as-is so any valid CoinGecko id works too (e.g. /api/price/degen-base).
const SYMBOL_MAP: Record<string, string> = {
  btc: "bitcoin",
  eth: "ethereum",
  sol: "solana",
  usdc: "usd-coin",
  usdt: "tether",
  bnb: "binancecoin",
  xrp: "ripple",
  doge: "dogecoin",
  avax: "avalanche-2",
  link: "chainlink",
  arb: "arbitrum",
  op: "optimism",
  aero: "aerodrome-finance",
  degen: "degen-base",
};

export async function getPrice(symbol: string) {
  const id = SYMBOL_MAP[symbol.toLowerCase()] ?? symbol.toLowerCase();
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(
    id,
  )}&vs_currencies=usd&include_24hr_change=true`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Upstream price source returned ${res.status}`);
  const data = (await res.json()) as Record<
    string,
    { usd?: number; usd_24h_change?: number }
  >;
  const entry = data[id];
  if (!entry?.usd) throw new Error(`Unknown asset: ${symbol}`);
  return {
    symbol: symbol.toLowerCase(),
    id,
    usd: entry.usd,
    change24h: entry.usd_24h_change ?? null,
    at: new Date().toISOString(),
  };
}
