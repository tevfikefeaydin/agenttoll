/**
 * Refresh the baseline behind /api/stats using public RPC reads only.
 *
 * A validated checkpoint resumes at block + 1. A legacy file is rebuilt once
 * to establish its scanned range, counting policy and finalized block hash.
 * Hash/policy/range mismatches fail without replacing the last good file.
 *
 *   node --import tsx scripts/stats-snapshot.mjs
 *   node --import tsx scripts/stats-snapshot.mjs --full-rebuild
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { scanTollLogs, blockCheckpoint, blockMinedAt, LOG_CHUNK } from "../src/services/stats.ts";
import { parseStatsBaseline, STATS_COUNTING_POLICY } from "../src/services/stats-baseline.ts";

const DEFAULT_PAY_TO = "0xe55359021a6a22d8385b827405991c56075f56f8";
const PAY_TO = (process.env.ADDRESS ?? DEFAULT_PAY_TO).toLowerCase();
const firstBlockInput = process.env.STATS_FROM_BLOCK ?? "49340000";
const FIRST_BLOCK = Number(firstBlockInput);
const OUT = path.join(process.cwd(), "data", "stats.json");
const fullRebuild = process.argv.slice(2).includes("--full-rebuild");

if (process.argv.slice(2).some(arg => arg !== "--full-rebuild")) throw new Error("Unknown argument; use --full-rebuild to rebuild history");
if (!/^0x[0-9a-f]{40}$/.test(PAY_TO)) throw new Error("Invalid stats recipient address");
if (!/^\d+$/.test(firstBlockInput) || !Number.isSafeInteger(FIRST_BLOCK) || FIRST_BLOCK < 0) throw new Error("Invalid STATS_FROM_BLOCK; expected a nonnegative safe integer");
if (PAY_TO !== DEFAULT_PAY_TO && process.env.STATS_FROM_BLOCK === undefined) throw new Error("Set STATS_FROM_BLOCK explicitly for a custom ADDRESS");

let base;
if (!fullRebuild && fs.existsSync(OUT)) {
  try {
    base = parseStatsBaseline(JSON.parse(fs.readFileSync(OUT, "utf8")), PAY_TO, "base");
    if (base.schemaVersion === 1 && base.fromBlock !== FIRST_BLOCK) throw new Error("Stats baseline start block differs from STATS_FROM_BLOCK");
  } catch (error) {
    throw new Error(`${error.message}. Use --full-rebuild to replace this baseline after checking the configured range.`);
  }
}

const resume = base?.schemaVersion === 1;
if (!resume) console.log(fullRebuild ? "Explicit full rebuild" : base ? "Legacy baseline: full rebuild to establish a checkpoint" : "No baseline: full rebuild");
const target = await blockCheckpoint("finalized", "base");
if (FIRST_BLOCK > target.block) throw new Error("STATS_FROM_BLOCK is ahead of the finalized chain head");
if (resume) {
  if (base.block > target.block) throw new Error("Stats checkpoint is ahead of the finalized chain head; refusing to roll it back");
  const checkpoint = await blockCheckpoint(base.block, "base");
  if (checkpoint.hash !== base.blockHash.toLowerCase()) throw new Error("Stats checkpoint hash mismatch. Verify the chain and use --full-rebuild.");
}

const start = resume ? base.block + 1 : FIRST_BLOCK;
console.log(`scanning ${start} → ${target.block} (${Math.max(0, Math.ceil((target.block - start + 1) / LOG_CHUNK))} chunks)`);
const payers = new Map(resume ? Object.entries(base.payers).map(([addr, p]) => [addr.toLowerCase(), { calls: p.calls, usdc: BigInt(p.usdcUnits) }]) : []);
let firstBlock = Infinity;
let lastBlock = -1;

for (let from = start; from <= target.block; from += LOG_CHUNK) {
  const to = Math.min(from + LOG_CHUNK - 1, target.block);
  let tolls;
  // Never promote a partial scan. Both providers are read-only and retries
  // are bounded; a failure leaves the committed baseline untouched.
  for (let attempt = 1; ; attempt++) {
    try {
      tolls = await scanTollLogs(PAY_TO, from, to, "base");
      break;
    } catch (error) {
      if (attempt >= 4) throw new Error(`blocks ${from}-${to}: ${error.message}`);
      await new Promise(resolve => setTimeout(resolve, 500 * attempt));
    }
  }
  for (const toll of tolls) {
    const seen = payers.get(toll.sender) ?? { calls: 0, usdc: 0n };
    payers.set(toll.sender, { calls: seen.calls + 1, usdc: seen.usdc + toll.value });
    firstBlock = Math.min(firstBlock, toll.block);
    lastBlock = Math.max(lastBlock, toll.block);
  }
  process.stdout.write(".");
}
console.log();

let firstTollAt = resume ? base.firstTollAt : null;
let lastTollAt = resume ? base.lastTollAt : null;
if (lastBlock >= 0) {
  if (firstTollAt === null) firstTollAt = await blockMinedAt(firstBlock, "base");
  lastTollAt = firstBlock === lastBlock && firstTollAt !== null && (!resume || Object.keys(base.payers).length === 0)
    ? firstTollAt : await blockMinedAt(lastBlock, "base");
}
// A changing boundary invalidates the run, including any counts accumulated
// during it. This detects checkpoint changes; it does not prove RPC log completeness.
const after = await blockCheckpoint(target.block, "base");
if (after.hash !== target.hash) throw new Error("Stats target block hash changed during the scan; retry before writing a snapshot");

const snapshot = {
  network: "base", payTo: PAY_TO,
  schemaVersion: 1, fromBlock: FIRST_BLOCK, countingPolicy: STATS_COUNTING_POLICY,
  block: target.block, blockHash: target.hash,
  at: new Date().toISOString(), firstTollAt, lastTollAt,
  payers: Object.fromEntries([...payers.entries()]
    .sort((a, b) => b[1].calls - a[1].calls)
    .map(([addr, p]) => [addr, { calls: p.calls, usdcUnits: p.usdc.toString() }])),
};
parseStatsBaseline(snapshot, PAY_TO, "base");

// Same-directory rename avoids exposing a partially written JSON file.
fs.mkdirSync(path.dirname(OUT), { recursive: true });
const temporary = `${OUT}.${randomUUID()}.tmp`;
try {
  fs.writeFileSync(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { flag: "wx" });
  fs.renameSync(temporary, OUT);
} finally {
  if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
}
const tolls = [...payers.values()].reduce((n, p) => n + p.calls, 0);
const revenue = [...payers.values()].reduce((n, p) => n + p.usdc, 0n);
console.log(`${OUT}: ${tolls} qualifying transfers, $${Number(revenue) / 1e6}, ${payers.size} payers, through finalized block ${target.block}`);