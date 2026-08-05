import { cached, fetchWithTimeout } from "./cache.js";
import { badRequest } from "./errors.js";
import { fromSources } from "./sources.js";

interface TokenPrice {
  chain: string;
  token: string;
  usd: number;
  source: string;
  at: string;
}

// Onchain spot price for any Base token by contract address.
export async function getBaseTokenPrice(address: string) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    badRequest("Invalid token address — expected 0x + 40 hex chars");
  }
  const addr = address.toLowerCase();
  return cached(`basetoken:${addr}`, 30_000, () =>
    fromSources<TokenPrice>(`base token ${addr}`, [
      { name: "geckoterminal", load: () => fromGeckoTerminal(addr) },
      { name: "dexscreener", load: () => fromDexScreener(addr) },
    ]),
  );
}

async function fromGeckoTerminal(addr: string): Promise<TokenPrice> {
  const res = await fetchWithTimeout(
    `https://api.geckoterminal.com/api/v2/simple/networks/base/token_price/${addr}`,
    { headers: { Accept: "application/json" } },
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as {
    data?: { attributes?: { token_prices?: Record<string, string> } };
  };
  const price = json.data?.attributes?.token_prices?.[addr];
  if (!price) throw new Error("no price for this token");
  return { chain: "base", token: addr, usd: Number(price), source: "geckoterminal", at: new Date().toISOString() };
}

async function fromDexScreener(addr: string): Promise<TokenPrice> {
  const res = await fetchWithTimeout(`https://api.dexscreener.com/latest/dex/tokens/${addr}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as {
    pairs?: {
      chainId?: string;
      priceUsd?: string;
      liquidity?: { usd?: number };
      baseToken?: { address?: string };
    }[];
  };
  // priceUsd always describes the pair's BASE token, so pairs where our token
  // is the quote side would report the other asset's price. Keep only pairs
  // where we are the base token, then trust the deepest one on Base.
  const best = (json.pairs ?? [])
    .filter(
      (p) =>
        p.chainId === "base" &&
        p.baseToken?.address?.toLowerCase() === addr &&
        Number(p.priceUsd) > 0,
    )
    .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
  if (!best) throw new Error("no Base pair with this token as base");
  return {
    chain: "base",
    token: addr,
    usd: Number(best.priceUsd),
    source: "dexscreener",
    at: new Date().toISOString(),
  };
}
