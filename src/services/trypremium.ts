import { cached, fetchWithTimeout } from "./cache.js";

// Turkish lira premium: implied USD/TRY from BTC cross-rate vs the official
// rate. When locals pay a premium for crypto, this number says how much.
export async function getTryPremium() {
  return cached("trypremium", 60_000, async () => {
    const [cg, fx] = await Promise.all([
      fetchWithTimeout(
        "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd,try",
      ),
      fetchWithTimeout("https://open.er-api.com/v6/latest/USD"),
    ]);
    if (!cg.ok) throw new Error(`Upstream price source returned ${cg.status}`);
    if (!fx.ok) throw new Error(`Upstream fx source returned ${fx.status}`);
    const btc = ((await cg.json()) as { bitcoin: { usd: number; try: number } }).bitcoin;
    const rates = ((await fx.json()) as { rates: { TRY: number } }).rates;
    const impliedUsdTry = btc.try / btc.usd;
    const officialUsdTry = rates.TRY;
    return {
      btcUsd: btc.usd,
      btcTry: btc.try,
      impliedUsdTry: Number(impliedUsdTry.toFixed(4)),
      officialUsdTry,
      premiumPct: Number(((impliedUsdTry / officialUsdTry - 1) * 100).toFixed(3)),
      at: new Date().toISOString(),
    };
  });
}
