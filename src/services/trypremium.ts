import { cached, fetchWithTimeout } from "./cache.js";
import { optionalEnum } from "./params.js";

// Turkish lira premium: implied USD/TRY from a crypto cross-rate vs the
// official rate. When locals pay a premium for crypto, this number says how
// much. BTC is the default reading; USDT is the one desks quote, because it is
// what actually changes hands when lira leaves the country.
const ASSETS = {
  btc: "bitcoin",
  eth: "ethereum",
  usdt: "tether",
  usdc: "usd-coin",
} as const;

type Asset = keyof typeof ASSETS;

/** The official rate is the same for every asset, so it gets its own cache slot. */
async function officialUsdTry(): Promise<number> {
  return cached("fx:usdtry", 60_000, async () => {
    const res = await fetchWithTimeout("https://open.er-api.com/v6/latest/USD");
    if (!res.ok) throw new Error(`Upstream fx source returned ${res.status}`);
    const rate = ((await res.json()) as { rates?: { TRY?: number } }).rates?.TRY;
    if (!rate) throw new Error("Upstream fx source returned no TRY rate");
    return rate;
  });
}

export async function getTryPremium(assetRaw?: string) {
  const asset: Asset = optionalEnum("asset", assetRaw, Object.keys(ASSETS) as Asset[]) ?? "btc";
  const id = ASSETS[asset];

  return cached(`trypremium:${asset}`, 60_000, async () => {
    const [cg, official] = await Promise.all([
      fetchWithTimeout(
        `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd,try`,
      ),
      officialUsdTry(),
    ]);
    if (!cg.ok) throw new Error(`Upstream price source returned ${cg.status}`);
    const quote = ((await cg.json()) as Record<string, { usd?: number; try?: number }>)[id];
    if (!quote?.usd || !quote?.try) {
      throw new Error(`Upstream price source returned no USD/TRY pair for ${asset}`);
    }
    const impliedUsdTry = quote.try / quote.usd;
    return {
      asset,
      assetUsd: quote.usd,
      assetTry: quote.try,
      impliedUsdTry: Number(impliedUsdTry.toFixed(4)),
      officialUsdTry: official,
      premiumPct: Number(((impliedUsdTry / official - 1) * 100).toFixed(3)),
      at: new Date().toISOString(),
    };
  });
}
