import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { paymentMiddleware, type Network } from "x402-express";
import { getPrice } from "./services/prices.js";
import { getGas } from "./services/gas.js";
import { getTrending } from "./services/trending.js";
import { getBaseTokenPrice } from "./services/basetoken.js";
import { getAddressInfo } from "./services/address.js";
import { getFearGreed } from "./services/feargreed.js";
import { getBaseTrending } from "./services/basetrending.js";
import { getMarketBrief } from "./services/brief.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// payTo is a public address (where USDC revenue lands); env can override it.
const PAY_TO = (process.env.ADDRESS ??
  "0xe55359021a6a22d8385b827405991c56075f56f8") as `0x${string}`;
export const NETWORK = (process.env.NETWORK ?? "base-sepolia") as Network;
const FACILITATOR_URL = (process.env.FACILITATOR_URL ??
  "https://x402.org/facilitator") as `${string}://${string}`;

const app = express();
app.set("trust proxy", true); // behind Vercel's proxy, keep https in quoted resource URLs
app.use(express.json());

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
    },
    { url: FACILITATOR_URL },
  ),
);

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "agenttoll", network: NETWORK });
});

// Free machine-readable catalog so agents can discover what is for sale.
app.get("/api/catalog", (_req, res) => {
  res.json({
    service: "agenttoll",
    description: "Pay-per-call data APIs for AI agents, paid in USDC via x402",
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
