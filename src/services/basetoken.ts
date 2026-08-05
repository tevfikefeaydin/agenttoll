import { cached, fetchWithTimeout } from "./cache.js";
import { badRequest } from "./errors.js";

// Onchain spot price for any Base token by contract address, via GeckoTerminal.
export async function getBaseTokenPrice(address: string) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    badRequest("Invalid token address — expected 0x + 40 hex chars");
  }
  const addr = address.toLowerCase();
  return cached(`basetoken:${addr}`, 30_000, async () => {
    const res = await fetchWithTimeout(
      `https://api.geckoterminal.com/api/v2/simple/networks/base/token_price/${addr}`,
      { headers: { Accept: "application/json" } },
    );
    if (!res.ok) throw new Error(`Upstream token price source returned ${res.status}`);
    const json = (await res.json()) as {
      data?: { attributes?: { token_prices?: Record<string, string> } };
    };
    const price = json.data?.attributes?.token_prices?.[addr];
    if (!price) throw new Error(`No price found for token ${address} on Base`);
    return {
      chain: "base",
      token: addr,
      usd: Number(price),
      at: new Date().toISOString(),
    };
  });
}
