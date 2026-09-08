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
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";

const BASE_URL = (process.env.AGENTTOLL_URL ?? "http://localhost:4021").replace(/\/+$/, "");
const local = ["localhost", "127.0.0.1", "[::1]"].includes(new URL(BASE_URL).hostname);
const network = process.env.AGENTTOLL_NETWORK ?? (local ? process.env.NETWORK ?? "base-sepolia" : "base");
const recipient = process.env.AGENTTOLL_RECIPIENT ?? (local ? process.env.ADDRESS : undefined);
const key = process.env.AGENT_PRIVATE_KEY;

if (!key) {
  console.error("Set AGENT_PRIVATE_KEY in .env to run the LangChain tool example.");
  process.exit(1);
}

const { fetchWithPayment } = payingFetch(key, network, {
  baseUrl: BASE_URL,
  recipient,
  totalBudgetUsdc: process.env.AGENTTOLL_BUDGET_USDC,
  maxPerCallUsdc: process.env.AGENTTOLL_MAX_PER_CALL_USDC,
  timeoutMs: process.env.AGENTTOLL_TIMEOUT_MS === undefined ? undefined : Number(process.env.AGENTTOLL_TIMEOUT_MS),
});

export const getTokenPrice = tool(
  async ({ symbol }: { symbol: string }, config) => {
    const res = await fetchWithPayment(`${BASE_URL}/api/price/${encodeURIComponent(symbol)}`, { signal: config?.signal });
    if (!res.ok) throw new Error(`AgentToll returned ${res.status}`);
    return JSON.stringify(await res.json());
  },
  {
    name: "get_token_price",
    description:
      "Get the current USD price and 24h change for a crypto asset (e.g. eth, btc, sol). " +
      "Costs at most $0.001 in USDC on the configured payment network, within a shared session budget (default $1).",
    schema: z.object({
      symbol: z.string().describe("Asset symbol, e.g. 'eth' or 'btc'"),
    }),
  },
);

// Standalone smoke test — call it directly the way an agent would.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const result = await getTokenPrice.invoke({ symbol: "eth" });
  console.log(result);
}
