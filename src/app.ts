import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { paymentMiddleware, type Network } from "x402-express";
import { facilitator as cdpFacilitator } from "@coinbase/x402";
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
import { getNewTokenRadar } from "./services/radar.js";
import { getTryPremium } from "./services/trypremium.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// payTo is a public address (where USDC revenue lands); env can override it.
const PAY_TO = (process.env.ADDRESS ??
  "0xe55359021a6a22d8385b827405991c56075f56f8") as `0x${string}`;
export const NETWORK = (process.env.NETWORK ?? "base-sepolia") as Network;
const FACILITATOR_URL = (process.env.FACILITATOR_URL ??
  "https://x402.org/facilitator") as `${string}://${string}`;

// Mainnet settles through the CDP facilitator (needs CDP_API_KEY_ID and
// CDP_API_KEY_SECRET in the environment); testnet uses the public one.
const FACILITATOR = (
  NETWORK === "base" ? cdpFacilitator : { url: FACILITATOR_URL }
) as Parameters<typeof paymentMiddleware>[2];

const app = express();
app.set("trust proxy", true); // behind Vercel's proxy, keep https in quoted resource URLs
app.disable("x-powered-by");
app.use(express.json({ limit: "10kb" }));

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

// Everything under /api/* (except /api/health) requires an x402 payment.
app.use(
  paymentMiddleware(
    PAY_TO,
    {
      "GET /api/price/*": {
        price: "$0.001",
        network: NETWORK,
        config: { description: "Spot price (USD) for a crypto asset" },
      },
      "GET /api/gas": {
        price: "$0.001",
        network: NETWORK,
        config: { description: "Base network gas price and latest block" },
      },
      "GET /api/trending": {
        price: "$0.002",
        network: NETWORK,
        config: { description: "Tokens trending across the market right now" },
      },
      "GET /api/base/token/*": {
        price: "$0.001",
        network: NETWORK,
        config: { description: "Onchain USD price for any Base token by contract address" },
      },
      "GET /api/base/address/*": {
        price: "$0.001",
        network: NETWORK,
        config: { description: "Base address snapshot: ETH balance, tx count, contract or EOA" },
      },
      "GET /api/feargreed": {
        price: "$0.001",
        network: NETWORK,
        config: { description: "Crypto Fear & Greed index with yesterday comparison" },
      },
      "GET /api/base/trending": {
        price: "$0.002",
        network: NETWORK,
        config: { description: "Trending DEX pools on Base: price, volume, liquidity" },
      },
      "GET /api/brief": {
        price: "$0.005",
        network: NETWORK,
        config: { description: "One-call market brief: BTC/ETH/SOL, Base gas, sentiment" },
      },
      "GET /api/base/radar": {
        price: "$0.003",
        network: NETWORK,
        config: { description: "New token radar: fresh Base pools that already have real liquidity" },
      },
      "GET /api/try/premium": {
        price: "$0.002",
        network: NETWORK,
        config: { description: "Turkish lira premium: implied vs official USD/TRY via BTC cross-rate" },
      },
      "GET /api/watch/address/*": {
        price: "$0.002",
        network: NETWORK,
        config: { description: "New activity for a Base address since your cursor (stateless watch)" },
      },
      "GET /api/watch/radar": {
        price: "$0.003",
        network: NETWORK,
        config: { description: "Only the Base pools that appeared since your cursor" },
      },
      "GET /api/watch/price/*": {
        price: "$0.001",
        network: NETWORK,
        config: { description: "Price alert check: has an asset moved past your threshold?" },
      },
    },
    FACILITATOR,
  ),
);

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
      "/api/base/token/{address}": { chain: "base", token: "0x9401...8631", usd: 0.424, at: "2026-07-31T08:52:06.109Z" },
      "/api/base/address/{address}": { chain: "base", address: "0xe553...56f8", ethBalance: 0, txCount: 1, isContract: true, at: "2026-07-31T08:52:05.955Z" },
      "/api/feargreed": { value: 25, classification: "Extreme Fear", yesterday: 28, at: "2026-07-31T08:52:06.318Z" },
      "/api/base/trending": { chain: "base", pools: [{ name: "msUSD / USDC 0.05%", priceUsd: 1.0, volume24hUsd: 6029571, change24hPct: 0.01, liquidityUsd: 2100000 }], at: "2026-07-31T09:10:00.000Z" },
      "/api/brief": { majors: { eth: { usd: 1880.43 }, btc: { usd: 63654 }, sol: { usd: 98.2 } }, baseGas: { gasPriceGwei: 0.006 }, sentiment: { value: 25 }, at: "2026-07-31T09:10:00.000Z" },
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
      { resource: `${PUBLIC_BASE}/api/gas`, price: "$0.001", description: "Base network gas price and latest block" },
      { resource: `${PUBLIC_BASE}/api/trending`, price: "$0.002", description: "Tokens trending across the market right now" },
      { resource: `${PUBLIC_BASE}/api/base/token/{address}`, price: "$0.001", description: "Onchain USD price for any Base token by contract address" },
      { resource: `${PUBLIC_BASE}/api/base/address/{address}`, price: "$0.001", description: "Base address snapshot: ETH balance, tx count, contract or EOA" },
      { resource: `${PUBLIC_BASE}/api/base/trending`, price: "$0.002", description: "Trending DEX pools on Base: price, volume, liquidity" },
      { resource: `${PUBLIC_BASE}/api/base/radar`, price: "$0.003", description: "New token radar: fresh Base pools with real liquidity" },
      { resource: `${PUBLIC_BASE}/api/feargreed`, price: "$0.001", description: "Crypto Fear & Greed index with yesterday comparison" },
      { resource: `${PUBLIC_BASE}/api/brief`, price: "$0.005", description: "One-call market brief: BTC/ETH/SOL, Base gas, sentiment" },
      { resource: `${PUBLIC_BASE}/api/try/premium`, price: "$0.002", description: "Turkish lira premium: implied vs official USD/TRY via BTC cross-rate" },
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
      { path: "/api/gas", method: "GET", price: "$0.001", description: "Base network gas price and latest block" },
      { path: "/api/trending", method: "GET", price: "$0.002", description: "Tokens trending across the market right now" },
      { path: "/api/base/token/{address}", method: "GET", price: "$0.001", description: "Onchain USD price for any Base token by contract address" },
      { path: "/api/base/address/{address}", method: "GET", price: "$0.001", description: "Base address snapshot: ETH balance, tx count, contract or EOA" },
      { path: "/api/base/trending", method: "GET", price: "$0.002", description: "Trending DEX pools on Base: price, volume, liquidity" },
      { path: "/api/feargreed", method: "GET", price: "$0.001", description: "Crypto Fear & Greed index with yesterday comparison" },
      { path: "/api/brief", method: "GET", price: "$0.005", description: "One-call market brief: BTC/ETH/SOL, Base gas, sentiment" },
      { path: "/api/base/radar", method: "GET", price: "$0.003", description: "New token radar: fresh Base pools that already have real liquidity" },
      { path: "/api/try/premium", method: "GET", price: "$0.002", description: "Turkish lira premium: implied vs official USD/TRY via BTC cross-rate" },
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

app.get("/api/price/:symbol", async (req, res) => {
  try {
    res.json(await getPrice(req.params.symbol));
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

app.get("/api/gas", async (_req, res) => {
  try {
    res.json(await getGas());
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

app.get("/api/trending", async (_req, res) => {
  try {
    res.json(await getTrending());
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

app.get("/api/base/token/:address", async (req, res) => {
  try {
    res.json(await getBaseTokenPrice(req.params.address));
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

app.get("/api/base/address/:address", async (req, res) => {
  try {
    res.json(await getAddressInfo(req.params.address));
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

app.get("/api/feargreed", async (_req, res) => {
  try {
    res.json(await getFearGreed());
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

app.get("/api/stats", async (_req, res) => {
  try {
    res.json(await getStats(PAY_TO));
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

app.get("/api/watch/address/:address", async (req, res) => {
  try {
    res.json(await getAddressActivity(req.params.address, req.query.since as string));
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

app.get("/api/watch/radar", async (req, res) => {
  try {
    res.json(await getRadarSince(req.query.since as string));
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

app.get("/api/watch/price/:symbol", async (req, res) => {
  try {
    res.json(
      await getPriceAlert(
        req.params.symbol,
        req.query.ref as string,
        req.query.pct as string,
      ),
    );
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

app.get("/api/base/radar", async (_req, res) => {
  try {
    res.json(await getNewTokenRadar());
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

app.get("/api/try/premium", async (_req, res) => {
  try {
    res.json(await getTryPremium());
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

app.get("/api/base/trending", async (_req, res) => {
  try {
    res.json(await getBaseTrending());
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

app.get("/api/brief", async (_req, res) => {
  try {
    res.json(await getMarketBrief());
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

// Local static serving; on Vercel the public/ folder is served by the CDN.
app.use(express.static(path.join(__dirname, "..", "public")));

export default app;
