// Assert identity, prices and parameter mappings, not only endpoint counts.
import { readFileSync } from "node:fs";
import { ENDPOINTS } from "../src/endpoints.ts";
import { DISCOVERY } from "../src/discovery.ts";
const read = file => readFileSync(new URL("../" + file, import.meta.url), "utf8");
const problems = [];
const spec = JSON.parse(read("public/openapi.json"));
const server = read("mcp/server.ts");
const tools = [...server.matchAll(/paidTool\(\s*"([^"]+)"([\s\S]*?)(?=\n\s*paidTool\(|\n\s*return server)/g)];
const normalize = value => value.replace(/\$\{encodeURIComponent\([^)]*\)\}/g, "{}").replace(/\{[^}]*\}/g, "{}");
if (tools.length !== ENDPOINTS.length) problems.push(`MCP paid tools: ${tools.length}, registry: ${ENDPOINTS.length}`);
if (new Set(ENDPOINTS.map(e => e.path)).size !== ENDPOINTS.length || new Set(ENDPOINTS.map(e => e.tool)).size !== ENDPOINTS.length) problems.push("Duplicate endpoint or tool identity");
if (Object.keys(DISCOVERY).length !== ENDPOINTS.length) problems.push("Discovery has an unregistered or missing endpoint");
for (const endpoint of ENDPOINTS) {
  const op = spec.paths[endpoint.path]?.get;
  if (!op || op.operationId !== endpoint.tool || op["x-payment-info"]?.price?.amount !== endpoint.price.slice(1)) problems.push(`OpenAPI identity/price mismatch: ${endpoint.path}`);
  if (!op?.responses?.["200"]?.content?.["application/json"]?.example) problems.push(`Missing example: ${endpoint.path}`);
  const tool = tools.find(match => match[1] === endpoint.tool);
  const call = tool?.[2].match(/call\(\s*(?:"([^"]+)"|`([^`]+)`)/);
  if (!call || normalize(call[1] ?? call[2]) !== normalize(endpoint.path)) problems.push(`MCP tool path mismatch: ${endpoint.tool}`);
}
const paidPaths = Object.entries(spec.paths).filter(([, operation]) => operation.get?.["x-payment-info"]);
if (paidPaths.length !== ENDPOINTS.length) problems.push("OpenAPI has an unregistered paid path");
for (const name of ["get_payment_quote", "get_payment_budget"]) if (!new RegExp(`server\\.tool\\(\\s*"${name}"`).test(server)) problems.push(`Missing free MCP tool ${name}`);
const pkg = JSON.parse(read("mcp/package.json"));
const registry = JSON.parse(read("mcp/server.json"));
if (registry.version !== pkg.version || registry.packages.some(p => p.version !== pkg.version)) problems.push("MCP registry version differs from package metadata");
const prices = ENDPOINTS.map(e => Number(e.price.slice(1)));
for (const file of ["public/llms.txt", "README.md", "mcp/README.md", "public/index.html", "mcp/server.json"]) {
  const text = read(file);
  for (const match of text.matchAll(/\$0\.\d+\s*[\u2013-]\s*\$0\.\d+/g)) {
    const [lo, hi] = match[0].split(/\s*[\u2013-]\s*/).map(value => Number(value.replace("$", "")));
    if (lo !== Math.min(...prices) || hi !== Math.max(...prices)) problems.push(`${file}: stale price range ${match[0]}`);
  }
  for (const match of text.matchAll(/(\d+)\s+(?:paid tools|endpoints)/gi)) if (Number(match[1]) !== ENDPOINTS.length) problems.push(`${file}: stale endpoint count ${match[0]}`);
}
if (problems.length) { for (const problem of problems) console.error(problem); process.exitCode = 1; }
else console.log(`${ENDPOINTS.length} endpoint identities, fees, MCP paths, OpenAPI operations and package version agree.`);
