/**
 * The product in ninety seconds, end to end and for real.
 *
 * Written to be screen-recorded: it pauses between beats so a narrator can
 * keep up, and every number on screen comes from a live call rather than a
 * fixture. It walks the actual chain the product exists for - find a pool
 * that is seconds old, ask whether its token is a trap, then show that we
 * keep the receipts - and it pays for the two calls it makes, on Base, in
 * front of the camera.
 *
 *   node scripts/demo.mjs           # the real thing, costs $0.007
 *   node scripts/demo.mjs --dry     # no payment: shows the 402 quote only
 *   SPEED=0 node scripts/demo.mjs   # no pauses, for a quick check
 *
 * The wallet comes from AGENT_PRIVATE_KEY and is never printed - only its
 * address, which is public and already visible on Basescan.
 */
import "dotenv/config";
import { payingFetch } from "../dist/pay.js";

const BASE = process.env.AGENTTOLL_URL ?? "https://agenttoll.app";
const DRY = process.argv.includes("--dry");
const SPEED = process.env.SPEED === undefined ? 1 : Number(process.env.SPEED);
const REPO = "https://github.com/tevfikefeaydin/agenttoll";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms * SPEED));
const line = (s = "") => console.log(s);
const rule = () => line("─".repeat(66));

async function beat(title) {
  line();
  rule();
  line(`  ${title}`);
  rule();
  await sleep(600);
}

/** Pulls the quote out of the 402 challenge, which v2 puts in a header. */
function quoteFrom(res) {
  const header = res.headers.get("payment-required");
  if (!header) return null;
  return JSON.parse(Buffer.from(header, "base64").toString("utf8"));
}

/** The settlement receipt the server hands back once payment clears. */
function receiptFrom(res) {
  const header = res.headers.get("payment-response");
  if (!header) return null;
  try {
    return JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

const usd = (amount) => `$${(Number(amount) / 1e6).toFixed(3)}`;

// ---------------------------------------------------------------- beat 1
await beat("1. There is no API key. There is a price.");
line(`  GET ${BASE}/api/base/fresh`);
await sleep(500);

const challenge = await fetch(`${BASE}/api/base/fresh`);
const quote = quoteFrom(challenge);
if (!quote) {
  console.error(`  Expected a 402 challenge, got HTTP ${challenge.status}.`);
  process.exit(1);
}
const accept = quote.accepts[0];

line();
line(`  HTTP ${challenge.status}  ${quote.error}`);
line(`  price     ${usd(accept.amount)} USDC`);
line(`  network   ${accept.network}   (Base mainnet)`);
line(`  payTo     ${accept.payTo}`);
line();
line("  The quote rides in the response header, and it carries this");
line("  endpoint's request and response schema with it - so an agent that");
line("  has only ever seen a 402 already knows how to call us.");
await sleep(2600);

if (DRY) {
  line();
  line("  --dry: stopping before payment.");
  process.exit(0);
}

const key = process.env.AGENT_PRIVATE_KEY;
if (!key) {
  console.error("\n  AGENT_PRIVATE_KEY missing - cannot make a paid call.");
  process.exit(1);
}
const { fetchWithPayment, address } = payingFetch(key, "base");

// ---------------------------------------------------------------- beat 2
await beat("2. The agent pays it, inline, and gets the data.");
line(`  wallet    ${address}`);
line("  paying...");

const started = Date.now();
const freshRes = await fetchWithPayment(`${BASE}/api/base/fresh?minutes=15&limit=5`);
const freshMs = Date.now() - started;
if (!freshRes.ok) {
  console.error(`  fresh -> HTTP ${freshRes.status}`);
  process.exit(1);
}
const fresh = await freshRes.json();
const receipt = receiptFrom(freshRes);

line();
line(`  HTTP ${freshRes.status}  in ${freshMs}ms`);
if (receipt?.transaction) {
  line(`  settled   ${receipt.transaction}`);
  line(`            https://basescan.org/tx/${receipt.transaction}`);
}
line();
line("  That is the whole business model. No account was created, no key");
line("  was issued, and nothing is charged when a request fails.");
await sleep(2800);

// ---------------------------------------------------------------- beat 3
await beat("3. What we sell: seeing a pool before the indexers do.");

const byAge = [...fresh.pools].sort((a, b) => a.ageSeconds - b.ageSeconds);
const withToken = byAge.filter((p) => p.token);
const ambiguous = byAge.length - withToken.length;
const subjectPool = withToken[0];

line(`  Uniswap v4 pools created in the last ${fresh.windowMinutes} minutes: ${fresh.summary.found}`);
line(`  read from Base block ${fresh.headBlock}`);
line(`  youngest one is ${byAge[0].ageSeconds} seconds old`);
line();
if (subjectPool) {
  line(`  launched token    ${subjectPool.token}`);
  line(`  age               ${subjectPool.ageSeconds} seconds`);
  line(`  funded already    ${subjectPool.funded ? "yes" : "not yet"}`);
  line(`  hook              ${subjectPool.hookPools === 1 ? "bespoke - shipped with this token" : `shared by ${subjectPool.hookPools} pools (a launchpad's)`}`);
}
line();
line("  Read straight off the PoolManager's own Initialize log, so a pool");
line("  surfaces about a block after it exists. No indexer sits in the path,");
line("  which is the entire reason this is worth paying for.");
if (ambiguous > 0) {
  line();
  line(`  ${ambiguous} of the ${byAge.length} pools returned came back with token: null.`);
  line("  Launchpads back tokens with their own assets, so the non-WETH side is");
  line("  not reliably the new one - when we cannot tell, we say so rather than");
  line("  guess. Getting that wrong quietly would be worse than not answering.");
}
await sleep(3000);

// ---------------------------------------------------------------- beat 4
if (subjectPool) {
  await beat("4. Then the question that actually matters: is it a trap?");
  line(`  GET ${BASE}/api/base/safety/${subjectPool.token}`);
  line("  paying $0.003...");

  const safetyRes = await fetchWithPayment(`${BASE}/api/base/safety/${subjectPool.token}`);
  if (safetyRes.ok) {
    const safety = await safetyRes.json();
    const tx = receiptFrom(safetyRes)?.transaction;
    line();
    line(`  token     ${safety.symbol ?? "?"}  ${safety.name ?? ""}`);
    line(`  VERDICT   ${String(safety.verdict).toUpperCase()}`);
    if (tx) line(`  settled   ${tx}`);
    line();

    // Lead with the checks that carry the verdict, then fill. A demo that
    // narrates checks the screen never shows is worse than a shorter demo.
    const checks = safety.checks ?? [];
    const first = ["honeypot", "taxes", "deployer", "owner-powers"];
    const ordered = [
      ...first.map((id) => checks.find((c) => c.id === id)).filter(Boolean),
      ...checks.filter((c) => !first.includes(c.id)),
    ];
    for (const check of ordered.slice(0, 6)) {
      line(`    ${check.status.padEnd(7)} ${check.id.padEnd(16)} ${check.detail.slice(0, 58)}`);
    }

    const unresolved = checks.filter((c) => c.status === "unknown" || c.status === "warn").length;
    line();
    if (safety.verdict === "insufficient-data" || unresolved >= 3) {
      line("  Note what it did NOT do: on a token this young the public sources");
      line("  have no holder or liquidity data yet, and it says so rather than");
      line("  filling the gap. A token we cannot verify is never called clear -");
      line("  that restraint is the product.");
    } else {
      line("  A simulated buy and sell, taxes, owner powers, holder concentration,");
      line("  whether anyone can still pull the liquidity - and the deployer's own");
      line("  history, because the strongest tell a rug leaves is not in the");
      line("  bytecode, it is in the wallet that shipped it.");
    }
  } else {
    line();
    line(`  safety -> HTTP ${safetyRes.status}`);
  }
  await sleep(3200);
}

// ---------------------------------------------------------------- beat 5
await beat("5. And then: were we right?");
line("  Every day, a CI job buys one scout call and commits the result to");
line("  public git, with the Base transaction that paid for it inside.");
line();
line(`  ${REPO}/tree/main/data/scout`);
line();
line("  So a verdict cannot be quietly rewritten after the fact. Anyone can");
line("  check what we flagged, on the date we flagged it, and what happened");
line("  to it since. Nobody else in this ecosystem publishes that.");
await sleep(2600);

// ---------------------------------------------------------------- close
line();
rule();
line("  20 paid endpoints. $0.001 to $0.008 a call. USDC on Base, via x402.");
line("  Open source, MIT. MCP server on npm as agenttoll-mcp.");
line(`  ${BASE}`);
rule();
line();
