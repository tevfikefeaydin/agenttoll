/**
 * The baseline behind /api/stats' second reading.
 *
 * Walks every USDC Transfer into the payTo address from the first toll to the
 * chain head and writes data/stats.json. The endpoint's fallback starts from
 * this file and only scans the blocks since, which is the difference between
 * ~150 sequential getLogs calls per request and about five.
 *
 * No wallet and no secrets: this only reads public logs off a public RPC.
 * Runs from CI daily (.github/workflows/stats-snapshot.yml).
 *
 *   node scripts/stats-snapshot.mjs
 */
import fs from "node:fs";
import path from "node:path";

// data/stats.json is the mainnet baseline, so pin the network before the
// module is evaluated — it picks its USDC address from the environment at
// import time, and a static import would run before this line.
process.env.NETWORK ??= "base";
const { scanTollLogs, latestBlock, blockMinedAt, LOG_CHUNK } = await import("../dist/services/stats.js");

const PAY_TO = process.env.ADDRESS ?? "0xe55359021a6a22d8385b827405991c56075f56f8";
// The block before the first toll ever settled (2026-07-31). Nothing to find
// below it, and starting at genesis would be 50M blocks of empty scanning.
const FIRST_BLOCK = Number(process.env.STATS_FROM_BLOCK ?? 49_340_000);
const OUT = path.join(process.cwd(), "data", "stats.json");

const head = await latestBlock();
console.log(`scanning ${FIRST_BLOCK} → ${head} (${Math.ceil((head - FIRST_BLOCK) / LOG_CHUNK)} chunks)`);

const payers = new Map();
let firstBlock = 0;
let lastBlock = 0;

for (let from = FIRST_BLOCK; from <= head; from += LOG_CHUNK) {
  const to = Math.min(from + LOG_CHUNK - 1, head);
  let tolls;
  // Public RPCs wobble; a chunk that fails silently would undercount forever,
  // so retry a few times and give up loudly rather than write a wrong file.
  for (let attempt = 1; ; attempt++) {
    try {
      tolls = await scanTollLogs(PAY_TO, from, to);
      break;
    } catch (err) {
      if (attempt >= 4) throw new Error(`blocks ${from}-${to}: ${err.message}`);
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }

  for (const toll of tolls) {
    const seen = payers.get(toll.sender) ?? { calls: 0, usdc: 0n };
    payers.set(toll.sender, { calls: seen.calls + 1, usdc: seen.usdc + toll.value });
    if (!firstBlock) firstBlock = toll.block;
    lastBlock = Math.max(lastBlock, toll.block);
  }
  process.stdout.write(".");
}
console.log();

const snapshot = {
  network: "base",
  payTo: PAY_TO,
  block: head,
  at: new Date().toISOString(),
  firstTollAt: firstBlock ? await blockMinedAt(firstBlock) : null,
  lastTollAt: lastBlock ? await blockMinedAt(lastBlock) : null,
  // Micro-USDC as strings: exact, and the reader parses them back to BigInt.
  payers: Object.fromEntries(
    [...payers.entries()]
      .sort((a, b) => b[1].calls - a[1].calls)
      .map(([addr, p]) => [addr, { calls: p.calls, usdcUnits: p.usdc.toString() }]),
  ),
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(snapshot, null, 2)}\n`);

const tolls = [...payers.values()].reduce((n, p) => n + p.calls, 0);
const revenue = [...payers.values()].reduce((n, p) => n + p.usdc, 0n);
console.log(`${OUT}: ${tolls} tolls, $${Number(revenue) / 1e6}, ${payers.size} payers, through block ${head}`);
