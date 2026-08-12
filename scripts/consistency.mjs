/**
 * Fails the build when the surfaces stop agreeing with each other.
 *
 * This repo keeps saying the same fact in several places — the paid routes, the
 * catalog, the well-known manifest, the OpenAPI spec, the MCP tool list, the
 * marketing copy — and every hand-kept one of them has silently fallen behind
 * at least once. /api/demo listed eleven of twenty endpoints. The site
 * advertised "14 tools" while npm shipped twenty. The pinned tweet said ten.
 * None of those broke anything, which is exactly why they survived so long.
 *
 * So the counts are asserted rather than trusted. Everything here is read off
 * the source files; no server and no network.
 *
 *   node scripts/consistency.mjs
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1"), "..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");

const problems = [];
const note = [];

// The paid routes are the source of truth: whatever the paywall is configured
// with is what the service actually sells.
const app = read("src/app.ts");
const paidRoutes = [...app.matchAll(/^\s*"(GET \/api\/[^"]+)": paid\(/gm)].map((m) => m[1]);
const N = paidRoutes.length;
note.push(`paid routes (src/app.ts): ${N}`);
if (N === 0) problems.push("could not find any paid routes — the regex in this script has drifted");

// Every paid route needs a schema declaration, or its 402 quote ships without one.
const discovery = read("src/discovery.ts");
for (const r of paidRoutes) {
  if (!discovery.includes(`"${r}"`)) problems.push(`no DISCOVERY entry for ${r}`);
}

// The catalog and the manifest are generated from lists in app.ts; count them.
const catalogPaid = [...app.matchAll(/\{ path: "\/api\/[^"]+", method: "GET", price: "\$/g)].length;
if (catalogPaid !== N) problems.push(`catalog lists ${catalogPaid} paid endpoints, the paywall has ${N}`);
const manifest = [...app.matchAll(/\{ resource: `\$\{PUBLIC_BASE\}\/api\//g)].length;
if (manifest !== N) problems.push(`well-known manifest lists ${manifest}, the paywall has ${N}`);

// The MCP server should expose one tool per paid endpoint.
const tools = (read("mcp/server.ts").match(/^  "[a-z_]+",$/gm) || []).length;
note.push(`MCP tools (mcp/server.ts): ${tools}`);
if (tools !== N) problems.push(`MCP exposes ${tools} tools for ${N} paid endpoints`);

// The OpenAPI spec must describe every paid operation, with a response example.
const spec = JSON.parse(read("public/openapi.json"));
const specPaid = Object.entries(spec.paths).filter(([p, ops]) => ops.get && !/\/api\/(health|catalog|demo|stats)$/.test(p));
if (specPaid.length !== N) problems.push(`openapi describes ${specPaid.length} paid operations, the paywall has ${N}`);
const noExample = specPaid.filter(([, ops]) => !ops.get.responses?.["200"]?.content?.["application/json"]?.example).map(([p]) => p);
if (noExample.length) problems.push(`openapi 200 example missing: ${noExample.join(", ")} — run scripts/openapi-examples.mjs`);
const noPayment = specPaid.filter(([, ops]) => !ops.get["x-payment-info"]).map(([p]) => p);
if (noPayment.length) problems.push(`openapi x-payment-info missing: ${noPayment.join(", ")}`);

// Prose that states a count goes stale the same way, so assert it too.
const WORDS = { 14: "fourteen", 18: "eighteen", 19: "nineteen", 20: "twenty", 21: "twenty-one" };
const site = read("public/index.html");
const numeric = [...site.matchAll(/(\d+)\s+(?:tools|endpoints)/gi)];
for (const m of numeric) {
  if (Number(m[1]) !== N) problems.push(`site says "${m[0]}" but there are ${N}`);
}
const spelled = [...site.matchAll(/\b(fourteen|eighteen|nineteen|twenty|twenty-one)\s+endpoints/gi)];
for (const m of spelled) {
  if (m[1].toLowerCase() !== WORDS[N]) problems.push(`site says "${m[0]}" but there are ${N}`);
}

// The advertised price range has to match what is actually charged.
const prices = [...app.matchAll(/paid\("GET [^"]+",\s*\n?\s*"\$([0-9.]+)"/g)].map((m) => Number(m[1]));
if (prices.length) {
  const lo = Math.min(...prices).toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  const hi = Math.max(...prices).toFixed(3);
  note.push(`price range: $${lo}–$${hi}`);
  for (const f of ["public/llms.txt", "README.md", "mcp/README.md", "public/index.html"]) {
    const text = read(f);
    const ranges = [...text.matchAll(/\$0\.\d+\s*[–-]\s*\$0\.\d+/g)].map((m) => m[0]);
    for (const r of ranges) {
      const [a, b] = r.split(/\s*[–-]\s*/).map((x) => Number(x.replace("$", "")));
      if (a !== Math.min(...prices) || b !== Math.max(...prices)) {
        problems.push(`${f} advertises "${r}" but the range is $${lo}–$${hi}`);
      }
    }
  }
}

for (const n of note) console.log(`  ${n}`);
if (problems.length) {
  console.error(`\n${problems.length} inconsistency(ies):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log("\nall surfaces agree");
