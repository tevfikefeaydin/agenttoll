/**
 * Example: wrapping an AgentToll endpoint as a LangChain.js tool.
 *
 * Usage:
 *   1. Put a funded wallet key in .env as AGENT_PRIVATE_KEY.
 *      Testnet USDC: https://faucet.circle.com (select Base Sepolia).
 *   2. npm install @langchain/core
 *   3. npm run example:langchain
 *
 * getTokenPrice can be dropped into any LangChain agent's tool list — the
 * model calls it like any other tool, and the $0.001 USDC payment happens
 * inline inside the fetch, via the same payingFetch used by the other
 * examples. No API key, no separate billing step.
 *
 * Hosted API: https://agenttoll.app
 */
import "dotenv/config";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { payingFetch } from "../src/pay.js";

const BASE_URL = process.env.AGENTTOLL_URL ?? "http://localhost:4021";
const key = process.env.AGENT_PRIVATE_KEY;

if (!key) {
  console.error("Set AGENT_PRIVATE_KEY in .env to run the LangChain tool example.");
  process.exit(1);
}

const { fetchWithPayment } = payingFetch(key);

export const getTokenPrice = tool(
  async ({ symbol }: { symbol: string }) => {
    const res = await fetchWithPayment(`${BASE_URL}/api/price/${symbol}`);
    if (!res.ok) throw new Error(`AgentToll returned ${res.status}`);
    return JSON.stringify(await res.json());
  },
  {
    name: "get_token_price",
    description:
      "Get the current USD price and 24h change for a crypto asset (e.g. eth, btc, sol). " +
      "Costs $0.001, paid automatically in USDC on Base via x402 — no API key.",
    schema: z.object({
      symbol: z.string().describe("Asset symbol, e.g. 'eth' or 'btc'"),
    }),
  },
);

// Standalone smoke test — call it directly the way an agent would.
if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await getTokenPrice.invoke({ symbol: "eth" });
  console.log(result);
}
