#!/usr/bin/env node
/**
 * AgentToll MCP server — exposes the pay-per-call API as MCP tools.
 *
 * Any MCP-compatible agent (Claude Desktop, Claude Code, etc.) can add this
 * server and start calling paid endpoints; each call is paid automatically
 * in USDC over x402. The agent wallet needs USDC on the configured network.
 *
 * Env:
 *   AGENT_PRIVATE_KEY  wallet that pays per call (optional for quote-only use)
 *   AGENTTOLL_URL      API base URL (default: https://agenttoll.app)
 *   AGENTTOLL_RECIPIENT expected recipient (required for a custom API host)
 *   AGENTTOLL_BUDGET_USDC session budget (default: 1)
 *   AGENTTOLL_MAX_PER_CALL_USDC optional lower per-call ceiling
 *   AGENTTOLL_TIMEOUT_MS total call deadline (default: 30000)
 *
 * Claude Desktop config example:
 *   "agenttoll": {
 *     "command": "npx",
 *     "args": ["-y", "tsx", "/path/to/agenttoll/mcp/server.ts"],
 *     "env": { "AGENT_PRIVATE_KEY": "0x..." }
 *   }
 */
import { McpServer, type ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import { toClientEvmSigner } from "@x402/evm";
import { createPaymentClient, type PaymentClientOptions } from "./payment-policy.js";
import { MCP_VERSION } from "./version.js";
import { ENDPOINT_MANIFEST } from "./endpoint-manifest.js";

export function createAgentTollServer(options: PaymentClientOptions & { privateKey?: string; network?: string } = {}) {
  const account = options.privateKey ? privateKeyToAccount(options.privateKey as `0x${string}`) : undefined;
  const payment = createPaymentClient(options.network ?? "base", account ? toClientEvmSigner(account) : undefined, options);

  type PaidCall = (path: string, query?: Record<string, string | number | undefined>) => Promise<string>;
  async function callEndpoint(signal: AbortSignal, path: string, query: Record<string, string | number | undefined> = {}) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) params.set(key, String(value));
    }
    const qs = params.toString();
    const res = await payment.fetchWithPayment(`${path}${qs ? `?${qs}` : ""}`, { method: "GET", signal });
    const body = await res.text();
    if (!res.ok) throw new Error(`AgentToll returned ${res.status}: ${body}`);
    return body;
  }

  const server = new McpServer({ name: "agenttoll", version: MCP_VERSION });
  function paidTool<Shape extends z.ZodRawShape>(
    name: typeof ENDPOINT_MANIFEST[number]["tool"], description: string, schema: Shape,
    callback: (args: z.output<z.ZodObject<Shape>>, call: PaidCall) => ReturnType<ToolCallback<z.ZodObject<Shape>>>,
  ) {
    const endpoint = ENDPOINT_MANIFEST.find(entry => entry.tool === name)!;
    // Every callback receives a call function bound to this MCP request's cancellation signal.
    return server.registerTool(name, {
      description: `${description} Costs ${endpoint.price} in USDC via x402.`,
      inputSchema: z.object(schema),
    }, (args, extra) => callback(args, (path, query) => callEndpoint(extra.signal, path, query)));
  }

  server.tool(
    "get_payment_budget",
    "Free: inspect the session USDC limit, spent/reserved/remaining amounts, expected network and recipient. Ambiguous signed failures remain reserved. This tool never requests a payment.",
    {},
    async () => ({ content: [{ type: "text", text: JSON.stringify(payment.getPaymentBudget()) }] }),
  );

  server.tool(
    "get_payment_quote",
    "Free: request and validate an unsigned x402 quote for a registered AgentToll endpoint path. Shows the quote and its price ceiling without using a private key or spending budget.",
    { path: z.string().describe("Concrete registered endpoint path with optional query, e.g. /api/price/eth or /api/base/fresh?minutes=5. Absolute URLs are not accepted.") },
    async ({ path }, { signal }) => ({ content: [{ type: "text", text: JSON.stringify(await payment.getPaymentQuote(path, { signal })) }] }),
  );

  paidTool(
    "get_price",
    "Spot price (USD) + 24h change for a crypto asset.",
    { symbol: z.string().describe("Ticker (eth, btc, sol...) or CoinGecko id") },
    async ({ symbol }, call) => ({
      content: [{ type: "text", text: await call(`/api/price/${encodeURIComponent(symbol)}`) }],
    }),
  );

  paidTool(
    "get_base_gas",
    "Base network gas price and latest block. Pass gasLimit to also get what a transaction that size would cost in ETH and USD.",
    {
      gasLimit: z
        .number()
        .int()
        .min(21_000)
        .max(30_000_000)
        .optional()
        .describe("Gas units to price: 21000 a transfer, ~65000 an ERC-20 transfer, 150000-300000 a swap"),
    },
    async ({ gasLimit }, call) => ({
      content: [{ type: "text", text: await call("/api/gas", { gasLimit }) }],
    }),
  );

  paidTool(
    "get_trending",
    "Tokens trending across the market right now.",
    { limit: z.number().int().min(1).max(25).optional().describe("Return only the top N tokens") },
    async ({ limit }, call) => ({
      content: [{ type: "text", text: await call("/api/trending", { limit }) }],
    }),
  );

  paidTool(
    "get_base_token_price",
    "Onchain USD price for any Base token by contract address.",
    { address: z.string().describe("Token contract address on Base (0x...)") },
    async ({ address }, call) => ({
      content: [{ type: "text", text: await call(`/api/base/token/${encodeURIComponent(address)}`) }],
    }),
  );

  paidTool(
    "get_base_address_info",
    "Base address snapshot: ETH balance, tx count, contract or EOA.",
    { address: z.string().describe("Address on Base (0x...)") },
    async ({ address }, call) => ({
      content: [{ type: "text", text: await call(`/api/base/address/${encodeURIComponent(address)}`) }],
    }),
  );

  paidTool(
    "get_fear_greed",
    "Crypto Fear & Greed index with yesterday comparison. Pass days to also get a daily history, which shows whether sentiment is turning.",
    { days: z.number().int().min(1).max(30).optional().describe("Days of daily history to include") },
    async ({ days }, call) => ({
      content: [{ type: "text", text: await call("/api/feargreed", { days }) }],
    }),
  );

  paidTool(
    "get_base_trending_pools",
    "Trending DEX pools on Base: price, 24h volume, liquidity.",
    { limit: z.number().int().min(1).max(20).optional().describe("How many pools to return (default 10)") },
    async ({ limit }, call) => ({
      content: [{ type: "text", text: await call("/api/base/trending", { limit }) }],
    }),
  );

  paidTool(
    "get_market_brief",
    "One-call market brief: prices, Base gas, Fear & Greed. Defaults to BTC/ETH/SOL; pass symbols to price whatever you actually track, at the same flat price.",
    {
      symbols: z
        .array(z.string())
        .max(6)
        .optional()
        .describe("Tickers or CoinGecko ids to price instead of the majors, e.g. ['eth','degen']"),
    },
    async ({ symbols }, call) => ({
      content: [
        { type: "text", text: await call("/api/brief", { symbols: symbols?.join(",") }) },
      ],
    }),
  );

  paidTool(
    "get_new_token_radar",
    "New token radar: pools created on Base in the last ~24h that already have real liquidity. The default floor is $10k; raise it to cut more spam, lower it to see everything new.",
    {
      minLiquidity: z.number().min(0).optional().describe("Liquidity floor in USD (default 10000)"),
      limit: z.number().int().min(1).max(30).optional().describe("How many pools to return (default 15)"),
    },
    async ({ minLiquidity, limit }, call) => ({
      content: [{ type: "text", text: await call("/api/base/radar", { minLiquidity, limit }) }],
    }),
  );

  paidTool(
    "get_try_premium",
    "Turkish lira premium: implied vs official USD/TRY via a crypto cross-rate. USDT is the reading desks quote, because it is what actually changes hands.",
    {
      asset: z
        .enum(["btc", "eth", "usdt", "usdc"])
        .optional()
        .describe("Which asset carries the cross-rate (default btc)"),
    },
    async ({ asset }, call) => ({
      content: [{ type: "text", text: await call("/api/try/premium", { asset }) }],
    }),
  );

  paidTool(
    "get_try_spread",
    "Turkish exchange spread: BTCTurk and Paribu's TRY quotes converted back to USD via the official rate and compared against the global price, so you can see which local exchange is charging the bigger premium.",
    {
      asset: z
        .enum(["btc", "usdt"])
        .optional()
        .describe("Which pair to check (default btc)"),
    },
    async ({ asset }, call) => ({
      content: [{ type: "text", text: await call("/api/try/spread", { asset }) }],
    }),
  );

  paidTool(
    "get_base_portfolio",
    "Everything a Base address holds, valued in USD: ETH plus its ERC-20 tokens, largest first. The reply carries totals and says how many holdings fell below the floor or could not be priced.",
    {
      address: z.string().describe("Address on Base (0x...)"),
      minValue: z
        .number()
        .min(0)
        .optional()
        .describe("USD floor per holding, which keeps airdropped spam out (default 1)"),
      limit: z.number().int().min(1).max(50).optional().describe("How many holdings to list (default 20)"),
    },
    async ({ address, minValue, limit }, call) => ({
      content: [
        {
          type: "text",
          text: await call(`/api/base/portfolio/${encodeURIComponent(address)}`, { minValue, limit }),
        },
      ],
    }),
  );

  paidTool(
    "check_token_safety",
    "Automated safety checks for a Base token: a simulated buy and sell to catch honeypots, buy/sell tax, contract verification, what the owner can still do, holder concentration, whether anyone can still withdraw the liquidity, and who deployed the contract - a token shipped from a wallet with a handful of transactions and dust in it is the shape most rugs share. The verdict is clear, caution, high-risk or insufficient-data — a token too new to check is never reported as clear.",
    { address: z.string().describe("Token contract address on Base (0x...)") },
    async ({ address }, call) => ({
      content: [
        { type: "text", text: await call(`/api/base/safety/${encodeURIComponent(address)}`) },
      ],
    }),
  );

  paidTool(
    "get_fresh_pools",
    "Pools read straight off Base seconds after they exist, before any indexer has them - the earliest possible signal that a token launched. Returns the launched token address (ready for check_token_safety), whether anyone has funded it yet, and whether its Uniswap v4 hook belongs to a launchpad used by many pools or is bespoke code shipped with this one token. USD liquidity is deliberately not claimed here; use get_new_token_radar for that, minutes later.",
    {
      minutes: z.number().int().min(1).max(60).optional().describe("How far back to look (default 10)"),
      limit: z.number().int().min(1).max(50).optional().describe("How many pools to return, youngest first (default 15)"),
      fundedOnly: z.boolean().optional().describe("Drop pools nobody has added liquidity to yet"),
    },
    async ({ minutes, limit, fundedOnly }, call) => ({
      content: [
        {
          type: "text",
          text: await call("/api/base/fresh", { minutes, limit, fundedOnly: fundedOnly === undefined ? undefined : String(fundedOnly) }),
        },
      ],
    }),
  );

  paidTool(
    "scout_new_tokens",
    "The radar and the safety check in one call: today's new Base pools above your liquidity floor, each returned with a safety verdict already attached (honeypot simulation, taxes, owner powers, holder concentration). One call instead of N+1. A pool whose check could not run is returned with safety: null, never dropped.",
    {
      minLiquidity: z.number().min(0).optional().describe("Liquidity floor in USD (default 15000)"),
      pools: z.number().int().min(1).max(4).optional().describe("How many of the top pools to check (default 3)"),
    },
    async ({ minLiquidity, pools }, call) => ({
      content: [{ type: "text", text: await call("/api/base/scout", { minLiquidity, pools }) }],
    }),
  );

  paidTool(
    "get_radar_scorecard",
    "Compare tokens in the latest published radar snapshots with current provider observations, grouped by their first observed safety verdict. Holding periods vary. Missing prices and outcomes remain null; liquidityGone means observed liquidity below $100, not proof that all liquidity disappeared. Coverage reports missing snapshots, unassessed tokens and unavailable quotes. Publication bytes are pinned to a git SHA.",
    { days: z.number().int().min(1).max(30).optional().describe("Number of latest published snapshot days, not a calendar lookback or fixed holding period (default 7)") },
    async ({ days }, call) => ({
      content: [{ type: "text", text: await call("/api/base/scorecard", { days }) }],
    }),
  );

  paidTool(
    "get_radar_history",
    "Read a published scout snapshot at an immutable git SHA, with provenance links and any recorded payment receipt. The SHA pins the published bytes; the receipt does not authenticate snapshot contents or prove capture time. Use this to inspect the observations behind get_radar_scorecard.",
    {
      date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe("Snapshot day as YYYY-MM-DD (default: the most recent one)"),
    },
    async ({ date }, call) => ({
      content: [{ type: "text", text: await call("/api/base/radar/history", { date }) }],
    }),
  );

  paidTool(
    "resolve_basename",
    "Resolve a Basename both ways: pass a name (agenttoll.base.eth, or just agenttoll) to get its address and text records, or pass a 0x address to get its primary basename.",
    { query: z.string().describe("A basename or a 0x address") },
    async ({ query }, call) => ({
      content: [{ type: "text", text: await call(`/api/base/name/${encodeURIComponent(query)}`) }],
    }),
  );

  paidTool(
    "watch_base_address",
    "Paginated Base address activity. Pass the previous reply's opaque cursor as since and drain pages while hasMore is true. partial and coverage describe incomplete scans; deduplicate overlapping/replayed transactions by hash.",
    {
      address: z.string().describe("Address on Base (0x...)"),
      since: z.string().optional().describe("Opaque cursor from the previous reply, or an initial ISO timestamp"),
    },
    async ({ address, since }, call) => ({
      content: [
        {
          type: "text",
          text: await call(`/api/watch/address/${encodeURIComponent(address)}`, { since }),
        },
      ],
    }),
  );

  paidTool(
    "watch_new_tokens",
    "Base pools in the current liquidity-filtered radar listing that appeared since a cursor. Pass the previous reply's cursor as since. The ranked listing is always partial; coverage.complete is false and older or late-indexed pools can be absent.",
    { since: z.string().optional().describe("ISO timestamp cursor from the previous reply") },
    async ({ since }, call) => ({
      content: [{ type: "text", text: await call("/api/watch/radar", { since }) }],
    }),
  );

  paidTool(
    "watch_price_alert",
    "Cheap poll: has an asset moved past a threshold from your reference price? Returns triggered true/false.",
    {
      symbol: z.string().describe("Ticker (eth, btc, sol...) or CoinGecko id"),
      ref: z.number().describe("Reference price in USD to compare against"),
      pct: z.number().optional().describe("Threshold in percent (default 2)"),
    },
    async ({ symbol, ref, pct }, call) => ({
      content: [
        {
          type: "text",
          text: await call(`/api/watch/price/${encodeURIComponent(symbol)}`, { ref, pct }),
        },
      ],
    }),
  );

  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const server = createAgentTollServer({
    privateKey: process.env.AGENT_PRIVATE_KEY,
    network: process.env.AGENTTOLL_NETWORK ?? "base",
    baseUrl: process.env.AGENTTOLL_URL,
    recipient: process.env.AGENTTOLL_RECIPIENT,
    totalBudgetUsdc: process.env.AGENTTOLL_BUDGET_USDC,
    maxPerCallUsdc: process.env.AGENTTOLL_MAX_PER_CALL_USDC,
    timeoutMs: process.env.AGENTTOLL_TIMEOUT_MS === undefined ? undefined : Number(process.env.AGENTTOLL_TIMEOUT_MS),
  });
  await server.connect(new StdioServerTransport());
  console.error(`AgentToll MCP server ready — ${process.env.AGENT_PRIVATE_KEY ? "bounded payments enabled" : "quote-only mode"}`);
}
