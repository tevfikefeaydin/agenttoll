import { getPrice } from "./prices.js";
import { getGas } from "./gas.js";
import { getFearGreed } from "./feargreed.js";

// One-call market snapshot: majors + Base gas + sentiment.
// Aggregation is the value: one request, one payment, whole picture.
export async function getMarketBrief() {
  const [eth, btc, sol, gas, sentiment] = await Promise.all([
    getPrice("eth"),
    getPrice("btc"),
    getPrice("sol"),
    getGas(),
    getFearGreed(),
  ]);
  return {
    majors: { eth, btc, sol },
    baseGas: gas,
    sentiment,
    at: new Date().toISOString(),
  };
}
