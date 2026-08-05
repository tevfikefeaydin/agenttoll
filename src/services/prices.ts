import { cached, fetchWithTimeout } from "./cache.js";
import { fromSources } from "./sources.js";

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

// Reverse lookup so a CoinGecko id can still reach the exchange fallbacks.
const TICKER_BY_ID = Object.fromEntries(
  Object.entries(SYMBOL_MAP).map(([ticker, id]) => [id, ticker.toUpperCase()]),
);

export interface Price {
  symbol: string;
  id: string;
  usd: number;
  change24h: number | null;
  source: string;
  at: string;
}

export async function getPrice(symbol: string): Promise<Price> {
  const key = symbol.toLowerCase();
  const id = SYMBOL_MAP[key] ?? key;
  const ticker = SYMBOL_MAP[key] ? key.toUpperCase() : TICKER_BY_ID[id];

  return cached(`price:${id}`, 30_000, () =>
    fromSources<Price>(`price ${key}`, [
      { name: "coingecko", load: () => fromCoinGecko(key, id) },
      // The exchange fallbacks only work for assets with a listed pair.
      ...(ticker
        ? [
            { name: "binance", load: () => fromBinance(key, id, ticker) },
            { name: "coinbase", load: () => fromCoinbase(key, id, ticker) },
          ]
        : []),
    ]),
  );
}

async function fromCoinGecko(symbol: string, id: string): Promise<Price> {
  const res = await fetchWithTimeout(
    `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(
      id,
    )}&vs_currencies=usd&include_24hr_change=true`,
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as Record<string, { usd?: number; usd_24h_change?: number }>;
  const entry = data[id];
  if (!entry?.usd) throw new Error(`unknown asset ${symbol}`);
  return {
    symbol,
    id,
    usd: entry.usd,
    change24h: entry.usd_24h_change ?? null,
    source: "coingecko",
    at: new Date().toISOString(),
  };
}

async function fromBinance(symbol: string, id: string, ticker: string): Promise<Price> {
  const pair = ticker === "USDT" ? "USDCUSDT" : `${ticker}USDT`;
  const res = await fetchWithTimeout(
    `https://api.binance.com/api/v3/ticker/24hr?symbol=${pair}`,
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { lastPrice?: string; priceChangePercent?: string };
  const usd = Number(data.lastPrice);
  if (!Number.isFinite(usd) || usd <= 0) throw new Error("no price in response");
  return {
    symbol,
    id,
    usd,
    change24h: data.priceChangePercent ? Number(data.priceChangePercent) : null,
    source: "binance",
    at: new Date().toISOString(),
  };
}

async function fromCoinbase(symbol: string, id: string, ticker: string): Promise<Price> {
  const res = await fetchWithTimeout(`https://api.coinbase.com/v2/prices/${ticker}-USD/spot`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { data?: { amount?: string } };
  const usd = Number(data.data?.amount);
  if (!Number.isFinite(usd) || usd <= 0) throw new Error("no price in response");
  // Coinbase's spot endpoint carries no 24h change; the field stays null.
  return { symbol, id, usd, change24h: null, source: "coinbase", at: new Date().toISOString() };
}
