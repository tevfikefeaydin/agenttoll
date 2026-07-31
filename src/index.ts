import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { paymentMiddleware, type Network } from "x402-express";
import { getPrice } from "./services/prices.js";
import { getGas } from "./services/gas.js";
import { getTrending } from "./services/trending.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PAY_TO = process.env.ADDRESS as `0x${string}` | undefined;
const NETWORK = (process.env.NETWORK ?? "base-sepolia") as Network;
const FACILITATOR_URL = (process.env.FACILITATOR_URL ??
  "https://x402.org/facilitator") as `${string}://${string}`;
const PORT = Number(process.env.PORT ?? 4021);

if (!PAY_TO) {
  console.error("Missing ADDRESS in .env — set the wallet that receives payments.");
  process.exit(1);
}

const app = express();
app.use(express.json());

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
    },
    { url: FACILITATOR_URL },
  ),
);

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "agenttoll", network: NETWORK });
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

app.use(express.static(path.join(__dirname, "..", "public")));

app.listen(PORT, () => {
  console.log(`AgentToll listening on http://localhost:${PORT}`);
  console.log(`Network: ${NETWORK} | payTo: ${PAY_TO}`);
});
