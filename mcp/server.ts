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
 *   AGENTTOLL_URL      API base URL (default: https://agenttoll.app)
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
import { createPublicClient, http } from "viem";
import { base, baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactEvmScheme, toClientEvmSigner } from "@x402/evm";

const BASE_URL = process.env.AGENTTOLL_URL ?? "https://agenttoll.app";
const pk = process.env.AGENT_PRIVATE_KEY;
if (!pk) {
  console.error("AGENT_PRIVATE_KEY is required (the wallet that pays per call).");
  process.exit(1);
}

// x402 v2 needs the chain in CAIP-2 form and a scheme registered per network.
const useTestnet = (process.env.AGENTTOLL_NETWORK ?? "base") !== "base";
const chain = useTestnet ? baseSepolia : base;
const caip2 = useTestnet ? "eip155:84532" : "eip155:8453";

const account = privateKeyToAccount(pk as `0x${string}`);
const publicClient = createPublicClient({ chain, transport: http() });
const payFetch = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [
    { network: caip2, client: new ExactEvmScheme(toClientEvmSigner(account, publicClient)) },
  ],
});

async function call(path: string, query: Record<string, string | number | undefined> = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const qs = params.toString();
  const res = await payFetch(`${BASE_URL}${path}${qs ? `?${qs}` : ""}`, { method: "GET" });
  const body = await res.text();
  if (!res.ok) throw new Error(`AgentToll returned ${res.status}: ${body}`);
  return body;
}

const server = new McpServer({ name: "agenttoll", version: "0.7.0" });

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
  "Base network gas price and latest block. Pass gasLimit to also get what a transaction that size would cost in ETH and USD. Costs $0.001 in USDC via x402.",
  {
    gasLimit: z
      .number()
      .int()
      .min(21_000)
      .max(30_000_000)
      .optional()
      .describe("Gas units to price: 21000 a transfer, ~65000 an ERC-20 transfer, 150000-300000 a swap"),
  },
  async ({ gasLimit }) => ({
    content: [{ type: "text", text: await call("/api/gas", { gasLimit }) }],
  }),
);

server.tool(
  "get_trending",
  "Tokens trending across the market right now. Costs $0.002 in USDC via x402.",
  { limit: z.number().int().min(1).max(25).optional().describe("Return only the top N tokens") },
  async ({ limit }) => ({
    content: [{ type: "text", text: await call("/api/trending", { limit }) }],
  }),
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
  "Crypto Fear & Greed index with yesterday comparison. Pass days to also get a daily history, which shows whether sentiment is turning. Costs $0.001 in USDC via x402.",
  { days: z.number().int().min(1).max(30).optional().describe("Days of daily history to include") },
  async ({ days }) => ({
    content: [{ type: "text", text: await call("/api/feargreed", { days }) }],
  }),
);

server.tool(
  "get_base_trending_pools",
  "Trending DEX pools on Base: price, 24h volume, liquidity. Costs $0.002 in USDC via x402.",
  { limit: z.number().int().min(1).max(20).optional().describe("How many pools to return (default 10)") },
  async ({ limit }) => ({
    content: [{ type: "text", text: await call("/api/base/trending", { limit }) }],
  }),
);

server.tool(
  "get_market_brief",
  "One-call market brief: prices, Base gas, Fear & Greed. Defaults to BTC/ETH/SOL; pass symbols to price whatever you actually track, at the same flat price. Costs $0.005 in USDC via x402.",
  {
    symbols: z
      .array(z.string())
      .max(6)
      .optional()
      .describe("Tickers or CoinGecko ids to price instead of the majors, e.g. ['eth','degen']"),
  },
  async ({ symbols }) => ({
    content: [
      { type: "text", text: await call("/api/brief", { symbols: symbols?.join(",") }) },
    ],
  }),
);

server.tool(
  "get_new_token_radar",
  "New token radar: pools created on Base in the last ~24h that already have real liquidity. The default floor is $10k; raise it to cut more spam, lower it to see everything new. Costs $0.003 in USDC via x402.",
  {
    minLiquidity: z.number().min(0).optional().describe("Liquidity floor in USD (default 10000)"),
    limit: z.number().int().min(1).max(30).optional().describe("How many pools to return (default 15)"),
  },
  async ({ minLiquidity, limit }) => ({
    content: [{ type: "text", text: await call("/api/base/radar", { minLiquidity, limit }) }],
  }),
);

server.tool(
  "get_try_premium",
  "Turkish lira premium: implied vs official USD/TRY via a crypto cross-rate. USDT is the reading desks quote, because it is what actually changes hands. Costs $0.002 in USDC via x402.",
  {
    asset: z
      .enum(["btc", "eth", "usdt", "usdc"])
      .optional()
      .describe("Which asset carries the cross-rate (default btc)"),
  },
  async ({ asset }) => ({
    content: [{ type: "text", text: await call("/api/try/premium", { asset }) }],
  }),
);

server.tool(
  "get_base_portfolio",
  "Everything a Base address holds, valued in USD: ETH plus its ERC-20 tokens, largest first. The reply carries totals and says how many holdings fell below the floor or could not be priced. Costs $0.003 in USDC via x402.",
  {
    address: z.string().describe("Address on Base (0x...)"),
    minValue: z
      .number()
      .min(0)
      .optional()
      .describe("USD floor per holding, which keeps airdropped spam out (default 1)"),
    limit: z.number().int().min(1).max(50).optional().describe("How many holdings to list (default 20)"),
  },
  async ({ address, minValue, limit }) => ({
    content: [
      {
        type: "text",
        text: await call(`/api/base/portfolio/${encodeURIComponent(address)}`, { minValue, limit }),
      },
    ],
  }),
);

server.tool(
  "check_token_safety",
  "Automated safety checks for a Base token: a simulated buy and sell to catch honeypots, buy/sell tax, contract verification, what the owner can still do, holder concentration, and whether anyone can still withdraw the liquidity. The verdict is clear, caution, high-risk or insufficient-data — a token too new to check is never reported as clear. Costs $0.003 in USDC via x402.",
  { address: z.string().describe("Token contract address on Base (0x...)") },
  async ({ address }) => ({
    content: [
      { type: "text", text: await call(`/api/base/safety/${encodeURIComponent(address)}`) },
    ],
  }),
);

server.tool(
  "resolve_basename",
  "Resolve a Basename both ways: pass a name (agenttoll.base.eth, or just agenttoll) to get its address and text records, or pass a 0x address to get its primary basename. Costs $0.001 in USDC via x402.",
  { query: z.string().describe("A basename or a 0x address") },
  async ({ query }) => ({
    content: [{ type: "text", text: await call(`/api/base/name/${encodeURIComponent(query)}`) }],
  }),
);

server.tool(
  "watch_base_address",
  "New activity for a Base address since a cursor — pass the previous reply's `cursor` as `since` to get only what changed. Costs $0.002 in USDC via x402.",
  {
    address: z.string().describe("Address on Base (0x...)"),
    since: z.string().optional().describe("ISO timestamp cursor from the previous reply"),
  },
  async ({ address, since }) => ({
    content: [
      {
        type: "text",
        text: await call(`/api/watch/address/${encodeURIComponent(address)}`, { since }),
      },
    ],
  }),
);

server.tool(
  "watch_new_tokens",
  "Only the Base pools that appeared since a cursor — pass the previous reply's `cursor` as `since`. Costs $0.003 in USDC via x402.",
  { since: z.string().optional().describe("ISO timestamp cursor from the previous reply") },
  async ({ since }) => ({
    content: [{ type: "text", text: await call("/api/watch/radar", { since }) }],
  }),
);

server.tool(
  "watch_price_alert",
  "Cheap poll: has an asset moved past a threshold from your reference price? Returns triggered true/false. Costs $0.001 in USDC via x402.",
  {
    symbol: z.string().describe("Ticker (eth, btc, sol...) or CoinGecko id"),
    ref: z.number().describe("Reference price in USD to compare against"),
    pct: z.number().optional().describe("Threshold in percent (default 2)"),
  },
  async ({ symbol, ref, pct }) => ({
    content: [
      {
        type: "text",
        text: await call(`/api/watch/price/${encodeURIComponent(symbol)}`, { ref, pct }),
      },
    ],
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`AgentToll MCP server ready — paying wallet ${account.address}, API ${BASE_URL}`);
