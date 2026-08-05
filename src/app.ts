import "dotenv/config";
import express, { type Request, type Response } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { paymentMiddlewareFromConfig } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { facilitator as cdpFacilitator } from "@coinbase/x402";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { DISCOVERY } from "./discovery.js";
import { getPrice } from "./services/prices.js";
import { getGas } from "./services/gas.js";
import { getTrending } from "./services/trending.js";
import { getBaseTokenPrice } from "./services/basetoken.js";
import { getAddressInfo } from "./services/address.js";
import { getFearGreed } from "./services/feargreed.js";
import { getBaseTrending } from "./services/basetrending.js";
import { getMarketBrief } from "./services/brief.js";
import { getStats } from "./services/stats.js";
import { getAddressActivity, getRadarSince, getPriceAlert } from "./services/watch.js";
import { BadRequestError } from "./services/errors.js";
import { resolveBasename } from "./services/basename.js";
import { getNewTokenRadar } from "./services/radar.js";
import { getPortfolio } from "./services/portfolio.js";
import { getTryPremium } from "./services/trypremium.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// payTo is a public address (where USDC revenue lands); env can override it.
const PAY_TO = (process.env.ADDRESS ??
  "0xe55359021a6a22d8385b827405991c56075f56f8") as `0x${string}`;
export const NETWORK = process.env.NETWORK ?? "base-sepolia";
const FACILITATOR_URL = process.env.FACILITATOR_URL ?? "https://x402.org/facilitator";

// x402 v2 identifies networks by CAIP-2 rather than by name.
const CHAIN: `${string}:${string}` = NETWORK === "base" ? "eip155:8453" : "eip155:84532";

// Mainnet settles through the CDP facilitator (needs CDP_API_KEY_ID and
// CDP_API_KEY_SECRET in the environment); testnet uses the public one.
const facilitatorClient = new HTTPFacilitatorClient(
  NETWORK === "base" ? cdpFacilitator : { url: FACILITATOR_URL },
);

/**
 * Every route is the same deal, only the price and the wording change.
 *
 * `route` is the key this config is filed under, which is also how we look up
 * the endpoint's schemas — declaring them here puts the request and response
 * shape inside the 402 quote itself, so an indexer that never manages to fetch
 * our OpenAPI spec still learns how to call the endpoint.
 */
const paid = (route: string, price: string, description: string) => ({
  accepts: { scheme: "exact", payTo: PAY_TO, price, network: CHAIN },
  description,
  extensions: declareDiscoveryExtension({
    ...DISCOVERY[route],
    output: { example: DISCOVERY[route].output },
  }),
});

const app = express();
app.set("trust proxy", true); // behind Vercel's proxy, keep https in quoted resource URLs
app.disable("x-powered-by");
app.use(express.json({ limit: "10kb" }));

// Indexers and uptime probes use HEAD. Express answers HEAD from the GET route,
// but the paywall is configured per "GET /path", so a HEAD probe skipped payment
// entirely: it ran the handler (burning upstream quota for free) and returned
// 200 where discovery crawlers expect a 402 challenge. Treating HEAD as GET puts
// it back behind the paywall; Node decided not to send a body when the request
// arrived, so the response stays header-only either way.
app.use((req, _res, next) => {
  if (req.method === "HEAD") req.method = "GET";
  next();
});

// Structured request log: one JSON line per API call (path, status, latency).
// This is the audit trail — query it via Vercel runtime logs.
app.use((req, res, next) => {
  if (!req.path.startsWith("/api/")) return next();
  const t0 = Date.now();
  res.on("finish", () => {
    console.log(
      JSON.stringify({
        t: new Date().toISOString(),
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms: Date.now() - t0,
        ip: req.ip,
        ua: req.get("user-agent")?.slice(0, 80) ?? null,
      }),
    );
  });
  next();
});

// Light per-IP rate limit for the free endpoints (paid ones are gated by payment
// itself). Per-instance only — Vercel's platform DDoS protection sits in front.
const freeHits = new Map<string, { n: number; reset: number }>();
app.use((req, res, next) => {
  if (!["/api/health", "/api/catalog", "/api/demo", "/api/stats", "/.well-known/x402"].includes(req.path)) return next();
  const ip = req.ip ?? "?";
  const now = Date.now();
  const slot = freeHits.get(ip);
  if (!slot || slot.reset < now) {
    if (freeHits.size > 5000) freeHits.clear();
    freeHits.set(ip, { n: 1, reset: now + 60_000 });
    return next();
  }
  if (++slot.n > 60) {
    res.status(429).json({ error: "Rate limited. Paid endpoints are not rate limited." });
    return;
  }
  next();
});

// CORS: browser-based agents must be able to read 402 quotes and send payments.
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-PAYMENT");
  res.setHeader("Access-Control-Expose-Headers", "X-PAYMENT-RESPONSE");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

// Everything under /api/* (except the free endpoints) requires an x402 payment.
app.use(
  paymentMiddlewareFromConfig(
    {
      "GET /api/price/:symbol": paid("GET /api/price/:symbol", "$0.001", "Spot price (USD) and 24h change for a crypto asset"),
      "GET /api/gas": paid("GET /api/gas",
        "$0.001",
        "Current Base network gas price and latest block number; add ?gasLimit=150000 to also get what a transaction that size costs in ETH and USD",
      ),
      "GET /api/trending": paid("GET /api/trending",
        "$0.002",
        "Tokens trending across the crypto market right now; ?limit=N trims the list",
      ),
      "GET /api/base/token/:address": paid("GET /api/base/token/:address",
        "$0.001",
        "Onchain USD price for any token on Base, looked up by contract address",
      ),
      "GET /api/base/address/:address": paid("GET /api/base/address/:address",
        "$0.001",
        "Snapshot of a Base address: primary basename, ETH balance, transaction count, and whether it is a contract",
      ),
      "GET /api/feargreed": paid("GET /api/feargreed",
        "$0.001",
        "Crypto Fear and Greed index with yesterday's value; ?days=7 adds a daily history so you can see whether sentiment is turning",
      ),
      "GET /api/base/trending": paid("GET /api/base/trending",
        "$0.002",
        "Trending DEX pools on Base right now, with price, 24h volume and liquidity; ?limit=N sets how many",
      ),
      "GET /api/brief": paid("GET /api/brief",
        "$0.005",
        "One-call market brief: prices (BTC, ETH and SOL by default, or ?symbols=eth,degen), Base gas, and market sentiment",
      ),
      "GET /api/base/radar": paid("GET /api/base/radar",
        "$0.003",
        "New token radar for Base: pools created in the last 24 hours that already hold real liquidity; ?minLiquidity sets the spam floor in USD, default 10000",
      ),
      "GET /api/try/premium": paid("GET /api/try/premium",
        "$0.002",
        "Turkish lira crypto premium: implied USD/TRY from a crypto cross-rate versus the official rate; ?asset=usdt is the reading desks quote",
      ),
      "GET /api/base/portfolio/:address": paid("GET /api/base/portfolio/:address",
        "$0.003",
        "Everything a Base address holds, valued in USD: ETH plus its ERC-20 tokens, largest first, with a spam floor you set",
      ),
      "GET /api/base/name/:nameOrAddress": paid("GET /api/base/name/:nameOrAddress",
        "$0.001",
        "Basename resolution both ways: a name returns its address and text records, an address returns its primary basename",
      ),
      "GET /api/watch/address/:address": paid("GET /api/watch/address/:address",
        "$0.002",
        "New activity for a Base address since your cursor, so a scheduled agent only fetches what changed",
      ),
      "GET /api/watch/radar": paid("GET /api/watch/radar",
        "$0.003",
        "Only the Base pools that appeared since your cursor, for agents polling on a schedule",
      ),
      "GET /api/watch/price/:symbol": paid("GET /api/watch/price/:symbol",
        "$0.001",
        "Price alert check: tells you whether an asset moved past your threshold from a reference price",
      ),
    },
    facilitatorClient,
    [{ network: CHAIN, server: new ExactEvmScheme() }],
  ),
);

// Express types path params and query values as string | string[]; the routes
// below only ever want the single-value form.
const one = (v: unknown): string => (Array.isArray(v) ? String(v[0]) : String(v ?? ""));
const opt = (v: unknown): string | undefined =>
  v === undefined ? undefined : one(v);

// Wraps a data source so a caller mistake reports as 400 and only a genuine
// upstream failure reports as 502. Either way x402 leaves the caller unbilled.
const serve =
  (load: (req: Request) => Promise<unknown>) =>
  async (req: Request, res: Response) => {
    try {
      res.json(await load(req));
    } catch (err) {
      const status = err instanceof BadRequestError ? 400 : 502;
      res.status(status).json({ error: (err as Error).message });
    }
  };

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "agenttoll", network: NETWORK });
});

// Free sample responses so people can see data shapes without a wallet.
app.get("/api/demo", (_req, res) => {
  res.json({
    note: "Sample shapes with static values. Pay per call for live data - see /api/catalog.",
    samples: {
      "/api/price/eth": { symbol: "eth", id: "ethereum", usd: 1902.36, change24h: 0.25, at: "2026-07-31T06:55:14.465Z" },
      "/api/gas": { chain: "base", gasPriceWei: "6000000", gasPriceGwei: 0.006, latestBlock: 49345179, at: "2026-07-31T06:35:04.787Z" },
      "/api/gas?gasLimit=150000": { chain: "base", gasPriceGwei: 0.006, latestBlock: 49345179, estimate: { gasLimit: 150000, ethCost: 9.0e-7, usdCost: 0.001692, ethUsd: 1867.28 }, at: "2026-07-31T06:35:04.787Z" },
      "/api/base/token/{address}": { chain: "base", token: "0x9401...8631", usd: 0.424, at: "2026-07-31T08:52:06.109Z" },
      "/api/base/address/{address}": { chain: "base", address: "0xe553...56f8", ethBalance: 0, txCount: 1, isContract: true, at: "2026-07-31T08:52:05.955Z" },
      "/api/feargreed": { value: 25, classification: "Extreme Fear", yesterday: 28, at: "2026-07-31T08:52:06.318Z" },
      "/api/base/trending": { chain: "base", pools: [{ name: "msUSD / USDC 0.05%", priceUsd: 1.0, volume24hUsd: 6029571, change24hPct: 0.01, liquidityUsd: 2100000 }], at: "2026-07-31T09:10:00.000Z" },
      "/api/brief": { majors: { eth: { usd: 1880.43 }, btc: { usd: 63654 }, sol: { usd: 98.2 } }, baseGas: { gasPriceGwei: 0.006 }, sentiment: { value: 25 }, at: "2026-07-31T09:10:00.000Z" },
      "/api/base/radar": { chain: "base", minLiquidityUsd: 10000, count: 1, pools: [{ name: "BASED / ETH 1%", pool: "0x2acb...cac0", createdAt: "2026-08-05T13:01:33Z", priceUsd: 0.0000156, volume24hUsd: 19071.46, liquidityUsd: 14246.1 }], at: "2026-08-05T13:31:00.000Z" },
      "/api/try/premium": { asset: "usdt", assetUsd: 0.999318, assetTry: 47.53, impliedUsdTry: 47.5624, officialUsdTry: 47.2891, premiumPct: 0.578, at: "2026-08-05T13:31:00.000Z" },
      "/api/base/portfolio/{address}": { chain: "base", address: "0x1985...5c87", basename: null, native: { symbol: "ETH", balance: 194.68, priceUsd: 1868.57, valueUsd: 363774.32 }, tokens: [{ symbol: "CBBTC", name: "Coinbase Wrapped BTC", address: "0xcbb7...33bf", balance: 5.673857, priceUsd: 64198, valueUsd: 364250.29 }], totalUsd: 7143109.27, tokenCount: 52, shown: 1, hiddenBelowFloor: 48, unpriced: 0, minValueUsd: 10000, source: "blockscout", at: "2026-08-05T13:31:00.000Z" },
    },
  });
});

// x402 discovery endpoint: the catalog in the emerging .well-known convention.
// PUBLIC_URL lets the deployment switch domains without a code change.
const PUBLIC_BASE = process.env.PUBLIC_URL ?? "https://agenttoll.app";
app.get("/.well-known/x402", (_req, res) => {
  res.json({
    x402Version: 1,
    name: "agenttoll",
    identity: "agenttoll.base.eth",
    network: NETWORK,
    payTo: PAY_TO,
    openapi: `${PUBLIC_BASE}/openapi.json`,
    llms: `${PUBLIC_BASE}/llms.txt`,
    mcp: "https://www.npmjs.com/package/agenttoll-mcp",
    resources: [
      { resource: `${PUBLIC_BASE}/api/price/{symbol}`, price: "$0.001", description: "Spot price (USD) + 24h change for a crypto asset" },
      { resource: `${PUBLIC_BASE}/api/gas`, price: "$0.001", description: "Base network gas price and latest block; ?gasLimit=N also costs a transaction that size" },
      { resource: `${PUBLIC_BASE}/api/trending`, price: "$0.002", description: "Tokens trending across the market right now; ?limit=N" },
      { resource: `${PUBLIC_BASE}/api/base/token/{address}`, price: "$0.001", description: "Onchain USD price for any Base token by contract address" },
      { resource: `${PUBLIC_BASE}/api/base/address/{address}`, price: "$0.001", description: "Base address snapshot: primary basename, ETH balance, tx count, contract or EOA" },
      { resource: `${PUBLIC_BASE}/api/base/portfolio/{address}`, price: "$0.003", description: "Everything a Base address holds, valued in USD: ETH plus ERC-20 tokens; ?minValue=USD&limit=N" },
      { resource: `${PUBLIC_BASE}/api/base/name/{nameOrAddress}`, price: "$0.001", description: "Basename resolution both ways: name to address, or address to primary name" },
      { resource: `${PUBLIC_BASE}/api/base/trending`, price: "$0.002", description: "Trending DEX pools on Base: price, volume, liquidity; ?limit=N" },
      { resource: `${PUBLIC_BASE}/api/base/radar`, price: "$0.003", description: "New token radar: fresh Base pools above your liquidity floor; ?minLiquidity=USD&limit=N" },
      { resource: `${PUBLIC_BASE}/api/feargreed`, price: "$0.001", description: "Crypto Fear & Greed index; ?days=1-30 adds daily history" },
      { resource: `${PUBLIC_BASE}/api/brief`, price: "$0.005", description: "One-call market brief: prices, Base gas, sentiment; ?symbols=eth,degen" },
      { resource: `${PUBLIC_BASE}/api/try/premium`, price: "$0.002", description: "Turkish lira premium: implied vs official USD/TRY; ?asset=btc|eth|usdt|usdc" },
      { resource: `${PUBLIC_BASE}/api/watch/address/{address}`, price: "$0.002", description: "New activity for a Base address since your cursor (stateless watch)" },
      { resource: `${PUBLIC_BASE}/api/watch/radar`, price: "$0.003", description: "Only the Base pools that appeared since your cursor" },
      { resource: `${PUBLIC_BASE}/api/watch/price/{symbol}`, price: "$0.001", description: "Price alert check against your reference and threshold" },
    ],
  });
});

// Free machine-readable catalog so agents can discover what is for sale.
app.get("/api/catalog", (_req, res) => {
  res.json({
    service: "agenttoll",
    description:
      "Base-native onchain data for AI agents, pay-per-call in USDC via x402. Open source (MIT).",
    network: NETWORK,
    payment: "x402",
    endpoints: [
      { path: "/api/price/{symbol}", method: "GET", price: "$0.001", description: "Spot price (USD) + 24h change for a crypto asset" },
      { path: "/api/gas?gasLimit={units}", method: "GET", price: "$0.001", description: "Base network gas price and latest block; with gasLimit, the ETH and USD cost of a transaction that size" },
      { path: "/api/trending?limit={n}", method: "GET", price: "$0.002", description: "Tokens trending across the market right now" },
      { path: "/api/base/token/{address}", method: "GET", price: "$0.001", description: "Onchain USD price for any Base token by contract address" },
      { path: "/api/base/address/{address}", method: "GET", price: "$0.001", description: "Base address snapshot: primary basename, ETH balance, tx count, contract or EOA" },
      { path: "/api/base/portfolio/{address}?minValue={usd}&limit={n}", method: "GET", price: "$0.003", description: "Everything a Base address holds, valued in USD: ETH plus ERC-20 tokens, largest first, spam floor default $1" },
      { path: "/api/base/name/{nameOrAddress}", method: "GET", price: "$0.001", description: "Basename resolution both ways: name to address (with text records), or address to primary name" },
      { path: "/api/base/trending?limit={n}", method: "GET", price: "$0.002", description: "Trending DEX pools on Base: price, volume, liquidity" },
      { path: "/api/feargreed?days={1-30}", method: "GET", price: "$0.001", description: "Crypto Fear & Greed index with yesterday comparison, optionally with daily history" },
      { path: "/api/brief?symbols={a,b,c}", method: "GET", price: "$0.005", description: "One-call market brief: prices (BTC/ETH/SOL by default), Base gas, sentiment" },
      { path: "/api/base/radar?minLiquidity={usd}&limit={n}", method: "GET", price: "$0.003", description: "New token radar: fresh Base pools above your liquidity floor, default $10k" },
      { path: "/api/try/premium?asset={btc|eth|usdt|usdc}", method: "GET", price: "$0.002", description: "Turkish lira premium: implied vs official USD/TRY via a crypto cross-rate" },
      { path: "/api/watch/address/{address}?since={iso}", method: "GET", price: "$0.002", description: "New activity for a Base address since your cursor; reply carries the next cursor" },
      { path: "/api/watch/radar?since={iso}", method: "GET", price: "$0.003", description: "Only the Base pools that appeared since your cursor" },
      { path: "/api/watch/price/{symbol}?ref={price}&pct={threshold}", method: "GET", price: "$0.001", description: "Price alert check: triggered true/false against your reference and threshold" },
      { path: "/api/stats", method: "GET", price: "free", description: "Onchain-derived toll counter: calls collected and USDC revenue" },
      { path: "/api/demo", method: "GET", price: "free", description: "Sample response shapes for every paid endpoint" },
      { path: "/api/health", method: "GET", price: "free", description: "Service status" },
      { path: "/api/catalog", method: "GET", price: "free", description: "This catalog" },
    ],
  });
});

app.get("/api/price/:symbol", serve((req) => getPrice(one(req.params.symbol))));
app.get("/api/gas", serve((req) => getGas(opt(req.query.gasLimit))));
app.get("/api/trending", serve((req) => getTrending(opt(req.query.limit))));
app.get("/api/base/token/:address", serve((req) => getBaseTokenPrice(one(req.params.address))));
app.get("/api/base/address/:address", serve((req) => getAddressInfo(one(req.params.address))));
app.get("/api/base/name/:query", serve((req) => resolveBasename(one(req.params.query))));
app.get(
  "/api/base/portfolio/:address",
  serve((req) =>
    getPortfolio(one(req.params.address), opt(req.query.minValue), opt(req.query.limit)),
  ),
);
app.get(
  "/api/base/radar",
  serve((req) => getNewTokenRadar(opt(req.query.minLiquidity), opt(req.query.limit))),
);
app.get("/api/base/trending", serve((req) => getBaseTrending(opt(req.query.limit))));
app.get("/api/feargreed", serve((req) => getFearGreed(opt(req.query.days))));
app.get("/api/brief", serve((req) => getMarketBrief(opt(req.query.symbols))));
app.get("/api/try/premium", serve((req) => getTryPremium(opt(req.query.asset))));
app.get("/api/stats", serve(() => getStats(PAY_TO)));

app.get(
  "/api/watch/address/:address",
  serve((req) => getAddressActivity(one(req.params.address), opt(req.query.since))),
);
app.get("/api/watch/radar", serve((req) => getRadarSince(opt(req.query.since))));
app.get(
  "/api/watch/price/:symbol",
  serve((req) =>
    getPriceAlert(one(req.params.symbol), opt(req.query.ref), opt(req.query.pct)),
  ),
);

// Local static serving; on Vercel the public/ folder is served by the CDN.
app.use(express.static(path.join(__dirname, "..", "public")));

export default app;
