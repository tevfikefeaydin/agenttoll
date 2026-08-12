/**
 * Fills the OpenAPI spec's 200 responses from the same declarations that feed
 * the 402 quotes and /api/demo.
 *
 * The spec described twenty endpoints without saying what any of them returned:
 * every 200 was a bare description like "Gas data". A developer reading
 * /openapi.json learned the price and the parameters but not the answer's
 * shape. That data already existed in src/discovery.ts — it just was not
 * reaching this surface.
 *
 * Kept out of the request path on purpose: the spec is a static file Vercel
 * serves directly, so this runs at author time rather than per request.
 *
 *   node scripts/openapi-examples.mjs          # rewrite public/openapi.json
 *   node scripts/openapi-examples.mjs --check  # fail if it would change
 *
 * Run it after touching DISCOVERY; --check is the guard that says you forgot.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1"), "..");
const SPEC = path.join(ROOT, "public", "openapi.json");
const CHECK = process.argv.includes("--check");

const { DISCOVERY } = await import(new URL("../src/discovery.ts", import.meta.url).href);

/** "GET /api/price/:symbol" -> "/api/price/{symbol}" */
const toSpecPath = (route) =>
  route.replace(/^GET\s+/, "").replace(/:([A-Za-z]+)/g, "{$1}");

const spec = JSON.parse(readFileSync(SPEC, "utf8"));
const before = JSON.stringify(spec);

const missing = [];
let filled = 0;

for (const [route, decl] of Object.entries(DISCOVERY)) {
  const p = toSpecPath(route);
  const op = spec.paths[p]?.get;
  if (!op) {
    missing.push(p);
    continue;
  }
  const res = (op.responses ??= {})["200"] ?? (op.responses["200"] = {});
  // Keep whatever description the spec already had; it is hand-written and
  // often says more than the example can.
  res.description ??= "Success";
  res.content = { "application/json": { example: decl.output } };
  filled++;
}

// The reverse direction matters too: a paid operation the declarations do not
// cover would silently keep its empty 200.
const paid = Object.entries(spec.paths).filter(
  ([p, ops]) => ops.get && !/\/api\/(health|catalog|demo|stats)$/.test(p),
);
const uncovered = paid.filter(([, ops]) => !ops.get.responses?.["200"]?.content).map(([p]) => p);

const after = JSON.stringify(spec, null, 2) + "\n";

if (missing.length) console.error(`declared but absent from the spec: ${missing.join(", ")}`);
if (uncovered.length) console.error(`paid operations still without a 200 example: ${uncovered.join(", ")}`);

if (CHECK) {
  // Compare content, not line endings. Git hands Windows checkouts CRLF while
  // this script writes LF, so a byte comparison called every Windows working
  // copy out of date and would have failed for a difference that does not
  // exist once the file is parsed.
  const norm = (s) => s.replace(/\r\n/g, "\n");
  const current = readFileSync(SPEC, "utf8");
  const drifted = norm(current) !== norm(after);
  console.log(drifted ? "openapi.json is out of date — run scripts/openapi-examples.mjs" : `openapi.json is current (${filled} examples)`);
  process.exit(drifted || missing.length || uncovered.length ? 1 : 0);
}

writeFileSync(SPEC, after);
console.log(`filled ${filled} response examples${before === JSON.stringify(spec) ? " (no change)" : ""}`);
process.exit(missing.length || uncovered.length ? 1 : 0);
