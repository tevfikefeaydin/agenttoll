/**
 * Daily scout snapshot — the raw material of the track record.
 *
 * Pays for one scout call and writes data/scout/<date>.json; CI publishes it
 * in git. A commit SHA pins the published bytes. The payment receipt records
 * settlement but does not authenticate those bytes or prove capture time.
 *
 *   node scripts/snapshot.mjs            # skips if today's file exists
 *   FORCE=1 node scripts/snapshot.mjs    # re-shoot today
 *   node scripts/snapshot.mjs --dry-run  # no HTTP, wallet or file writes
 *   node scripts/snapshot.mjs --quote-only # unsigned quote; no file writes
 *
 * Runs from CI daily (.github/workflows/snapshot.yml); costs $0.008/day.
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { decodePaymentResponseHeader } from "@x402/fetch";
import { automationOptions, automationPayment, previewAutomation, automationFailure } from "./automation-payment.mjs";

const DIR = path.join(process.cwd(), "data", "scout");
const date = new Date().toISOString().slice(0, 10);
const file = path.join(DIR, `${date}.json`);

function validateScout(scout) {
  const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const timestamp = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));
  const strings = (value) => Array.isArray(value) && value.every((entry) => typeof entry === "string");
  const validPool = (pool) => object(pool) && typeof pool.name === "string" &&
    typeof pool.pool === "string" && /^0x(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(pool.pool) &&
    (pool.token === null || (typeof pool.token === "string" && /^0x[0-9a-fA-F]{40}$/.test(pool.token))) &&
    timestamp(pool.createdAt) && [pool.priceUsd, pool.liquidityUsd, pool.volume24hUsd].every((value) => Number.isFinite(value) && value >= 0) &&
    (pool.safety === null || (object(pool.safety) &&
      ["high-risk", "caution", "insufficient-data", "clear"].includes(pool.safety.verdict) &&
      strings(pool.safety.failed) && strings(pool.safety.warnings) && strings(pool.safety.unchecked)));
  const counters = ["found", "checked", "unchecked", "highRisk", "caution", "insufficientData", "clear"];
  if (!object(scout) || !timestamp(scout.at) ||
      !Array.isArray(scout.pools) || scout.pools.length > 4 || scout.pools.some((pool) => !validPool(pool)) ||
      !object(scout.summary) || counters.some((name) => !Number.isSafeInteger(scout.summary[name]) || scout.summary[name] < 0) ||
      scout.summary.found !== scout.pools.length || scout.summary.checked + scout.summary.unchecked !== scout.pools.length ||
      scout.summary.highRisk + scout.summary.caution + scout.summary.insufficientData + scout.summary.clear !== scout.summary.checked) {
    throw new Error("Invalid scout response; no snapshot or index was written.");
  }
}

let client;
try {
  const options = automationOptions();
  if (options.mode === "pay" && fs.existsSync(file) && !process.env.FORCE) {
    console.log(`ok: ${date} zaten var, odeme yapilmadi`);
    process.exit(0);
  }
  client = automationPayment("/api/base/scout?minLiquidity=15000&pools=4", options.mode);
  if (await previewAutomation(client)) process.exit(0);

  const res = await client.fetchWithPayment(client.url, { method: "GET" });
  if (!res.ok) throw new Error(`scout -> HTTP ${res.status}`);
  const scout = await res.json();
  validateScout(scout);
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
    JSON.stringify({ ok: true, date, pools: scout.pools.length, highRisk: scout.summary.highRisk, settlement, budget: client.getPaymentBudget() }),
  );
} catch (error) {
  automationFailure(error, client, { date });
}
