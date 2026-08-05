import { getPrice, type Price } from "./prices.js";
import { getGas } from "./gas.js";
import { getFearGreed } from "./feargreed.js";
import { optionalSymbolList } from "./params.js";

// One-call market snapshot: majors + Base gas + sentiment.
// Aggregation is the value: one request, one payment, whole picture.
const DEFAULT_SYMBOLS = ["btc", "eth", "sol"];
const MAX_SYMBOLS = 6;

/**
 * `symbols` swaps the majors for whatever the agent actually tracks
 * (?symbols=eth,degen,aero) at the same flat price — the gas and sentiment
 * legs cost the same either way, and the price legs run in parallel.
 */
export async function getMarketBrief(symbolsRaw?: string) {
  const symbols = optionalSymbolList("symbols", symbolsRaw, MAX_SYMBOLS) ?? DEFAULT_SYMBOLS;

  const [prices, gas, sentiment] = await Promise.all([
    Promise.all(symbols.map((symbol) => getPrice(symbol))),
    getGas(),
    getFearGreed(),
  ]);

  const majors: Record<string, Price> = {};
  symbols.forEach((symbol, i) => {
    majors[symbol] = prices[i];
  });

  return {
    majors,
    baseGas: gas,
    sentiment,
    at: new Date().toISOString(),
  };
}
