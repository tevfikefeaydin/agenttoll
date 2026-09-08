/**
 * Daily scout snapshot — the raw material of the track record.
 *
 * Pays for one scout call and writes data/scout/<date>.json; CI publishes it
 * in git. A commit SHA pins the published bytes. The payment receipt records
 * settlement but does not authenticate those bytes or prove capture time.
 *
 *   node scripts/snapshot.mjs            # skips if today's file exists
 *   FORCE=1 node scripts/snapshot.mjs    # re-shoot today
 *
 * Runs from CI daily (.github/workflows/snapshot.yml); costs $0.008/day.
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { payingFetch } from "../dist/pay.js";
import { decodePaymentResponseHeader } from "@x402/fetch";

const BASE = (process.env.AGENTTOLL_URL ?? "https://agenttoll.app").replace(/\/+$/, "");
const local = ["localhost", "127.0.0.1", "[::1]"].includes(new URL(BASE).hostname);
const network = process.env.AGENTTOLL_NETWORK ?? (local ? process.env.NETWORK ?? "base-sepolia" : "base");
const recipient = process.env.AGENTTOLL_RECIPIENT ?? (local ? process.env.ADDRESS : undefined);
const DIR = path.join(process.cwd(), "data", "scout");
const date = new Date().toISOString().slice(0, 10);
const file = path.join(DIR, `${date}.json`);

if (fs.existsSync(file) && !process.env.FORCE) {
  console.log(`ok: ${date} zaten var, odeme yapilmadi`);
  process.exit(0);
}

const key = process.env.AGENT_PRIVATE_KEY;
if (!key) {
  console.error("AGENT_PRIVATE_KEY eksik.");
  process.exit(1);
}
const { fetchWithPayment } = payingFetch(key, network, {
  baseUrl: BASE, recipient,
  totalBudgetUsdc: process.env.AGENTTOLL_BUDGET_USDC,
  maxPerCallUsdc: process.env.AGENTTOLL_MAX_PER_CALL_USDC,
  timeoutMs: process.env.AGENTTOLL_TIMEOUT_MS === undefined ? undefined : Number(process.env.AGENTTOLL_TIMEOUT_MS),
});

const res = await fetchWithPayment(`${BASE}/api/base/scout?minLiquidity=15000&pools=4`, {
  method: "GET",
});
if (!res.ok) {
  console.error(`scout -> ${res.status}: ${(await res.text()).slice(0, 160)}`);
  process.exit(1);
}
const scout = await res.json();
const receipt = res.headers.get("payment-response");
const settlement = receipt
  ? ((decodePaymentResponseHeader(receipt) ?? {}).transaction ?? null)
  : null;

const snapshot = {
  date,
  at: scout.at,
  source: "scout",
  params: { minLiquidity: 15000, pools: 4 },
  // Payment receipt only; it does not bind the response contents or timestamp.
  settlement,
  summary: scout.summary,
  pools: scout.pools,
};

fs.mkdirSync(DIR, { recursive: true });
fs.writeFileSync(file, JSON.stringify(snapshot, null, 2) + "\n", "utf8");

// The index is what the history endpoint uses to know which dates exist.
const indexFile = path.join(DIR, "index.json");
const dates = fs
  .readdirSync(DIR)
  .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
  .map((f) => f.slice(0, 10))
  .sort();
fs.writeFileSync(indexFile, JSON.stringify({ dates, updatedAt: new Date().toISOString() }, null, 2) + "\n", "utf8");

console.log(
  JSON.stringify({ ok: true, date, pools: scout.pools.length, highRisk: scout.summary.highRisk, settlement }),
);
