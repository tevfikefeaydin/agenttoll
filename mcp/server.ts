#!/usr/bin/env node
/**
 * AgentToll MCP server — exposes the pay-per-call API as MCP tools.
 *
 * Any MCP-compatible agent (Claude Desktop, Claude Code, etc.) can add this
 * server and start calling paid endpoints; each call is paid automatically
 * in USDC over x402. The agent wallet needs USDC on the configured network.
 *
 * Env:
 *   AGENT_PRIVATE_KEY  wallet that pays per call (required)
 *   AGENTTOLL_URL      API base URL (default: https://agenttoll-pi.vercel.app)
 *
 * Claude Desktop config example:
 *   "agenttoll": {
 *     "command": "npx",
 *     "args": ["-y", "tsx", "/path/to/agenttoll/mcp/server.ts"],
 *     "env": { "AGENT_PRIVATE_KEY": "0x..." }
 *   }
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { privateKeyToAccount } from "viem/accounts";
import { wrapFetchWithPayment } from "x402-fetch";

const BASE_URL = process.env.AGENTTOLL_URL ?? "https://agenttoll-pi.vercel.app";
const pk = process.env.AGENT_PRIVATE_KEY;
if (!pk) {
  console.error("AGENT_PRIVATE_KEY is required (the wallet that pays per call).");
  process.exit(1);
}

const account = privateKeyToAccount(pk as `0x${string}`);
const payFetch = wrapFetchWithPayment(fetch, account);

async function call(path: string) {
  const res = await payFetch(`${BASE_URL}${path}`, { method: "GET" });
  const body = await res.text();
  if (!res.ok) throw new Error(`AgentToll returned ${res.status}: ${body}`);
  return body;
}

const server = new McpServer({ name: "agenttoll", version: "0.3.1" });

server.tool(
  "get_price",
  "Spot price (USD) + 24h change for a crypto asset. Costs $0.001 in USDC via x402.",
  { symbol: z.string().describe("Ticker (eth, btc, sol...) or CoinGecko id") },
  async ({ symbol }) => ({
    content: [{ type: "text", text: await call(`/api/price/${encodeURIComponent(symbol)}`) }],
  }),
);

server.tool(
  "get_base_gas",
  "Base network gas price and latest block. Costs $0.001 in USDC via x402.",
  {},
  async () => ({ content: [{ type: "text", text: await call("/api/gas") }] }),
);

server.tool(
  "get_trending",
  "Tokens trending across the market right now. Costs $0.002 in USDC via x402.",
  {},
  async () => ({ content: [{ type: "text", text: await call("/api/trending") }] }),
);

server.tool(
  "get_base_token_price",
  "Onchain USD price for any Base token by contract address. Costs $0.001 in USDC via x402.",
  { address: z.string().describe("Token contract address on Base (0x...)") },
  async ({ address }) => ({
    content: [{ type: "text", text: await call(`/api/base/token/${encodeURIComponent(address)}`) }],
  }),
);

server.tool(
  "get_base_address_info",
  "Base address snapshot: ETH balance, tx count, contract or EOA. Costs $0.001 in USDC via x402.",
  { address: z.string().describe("Address on Base (0x...)") },
  async ({ address }) => ({
    content: [{ type: "text", text: await call(`/api/base/address/${encodeURIComponent(address)}`) }],
  }),
);

server.tool(
  "get_fear_greed",
  "Crypto Fear & Greed index with yesterday comparison. Costs $0.001 in USDC via x402.",
  {},
  async () => ({ content: [{ type: "text", text: await call("/api/feargreed") }] }),
);

server.tool(
  "get_base_trending_pools",
  "Trending DEX pools on Base: price, 24h volume, liquidity. Costs $0.002 in USDC via x402.",
  {},
  async () => ({ content: [{ type: "text", text: await call("/api/base/trending") }] }),
);

server.tool(
  "get_market_brief",
  "One-call market brief: BTC/ETH/SOL prices, Base gas, Fear & Greed. Costs $0.005 in USDC via x402.",
  {},
  async () => ({ content: [{ type: "text", text: await call("/api/brief") }] }),
);

server.tool(
  "get_new_token_radar",
  "New token radar: pools created on Base in the last ~24h that already have real liquidity (min $10k). Costs $0.003 in USDC via x402.",
  {},
  async () => ({ content: [{ type: "text", text: await call("/api/base/radar") }] }),
);

server.tool(
  "get_try_premium",
  "Turkish lira premium: implied vs official USD/TRY via BTC cross-rate. Costs $0.002 in USDC via x402.",
  {},
  async () => ({ content: [{ type: "text", text: await call("/api/try/premium") }] }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`AgentToll MCP server ready — paying wallet ${account.address}, API ${BASE_URL}`);
