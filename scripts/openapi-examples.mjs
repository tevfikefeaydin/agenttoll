// Run with node --import tsx. Canonical descriptions, prices, parameters and examples.
import { readFileSync, writeFileSync } from "node:fs";
import { ENDPOINTS } from "../src/endpoints.ts";
const file = new URL("../public/openapi.json", import.meta.url);
const current = readFileSync(file, "utf8");
const spec = JSON.parse(current);
for (const endpoint of ENDPOINTS) {
  const operation = (spec.paths[endpoint.path] ??= {}).get ??= {};
  operation.summary = endpoint.description;
  operation.operationId = endpoint.tool;
  operation["x-payment-info"] ??= { price: { currency: "USD", mode: "fixed" } };
  operation["x-payment-info"].price.amount = endpoint.price.slice(1);
  operation.parameters = [];
  for (const [location, schema, examples] of [
    ["path", endpoint.discovery.pathParamsSchema, endpoint.discovery.pathParams],
    ["query", endpoint.discovery.inputSchema, endpoint.discovery.input],
  ]) for (const [name, property] of Object.entries(schema?.properties ?? {})) {
    operation.parameters.push({ name, in: location, required: location === "path" || Boolean(schema.required?.includes(name)), schema: property,
      ...(examples?.[name] === undefined ? {} : { example: examples[name] }) });
  }
  const responses = operation.responses ??= {};
  responses["200"] = { description: "Success. meta describes response freshness and configured networks.",
    content: { "application/json": { example: { ...endpoint.discovery.output, meta: { requestId: "example-request", servedAt: endpoint.discovery.output.at ?? "2026-08-19T12:00:00.000Z", observedAt: endpoint.discovery.output.at ?? null, ageSeconds: endpoint.discovery.output.at ? 0 : null, dataNetwork: "base", paymentNetwork: "base" } } } } };
  responses["402"] = { description: "Unsigned x402 v2 quote in the base64 JSON PAYMENT-REQUIRED header.", headers: { "PAYMENT-REQUIRED": { schema: { type: "string" } } } };
  for (const [status, description] of [[400, "Invalid input"], [429, "Rate limited"], [502, "Upstream unavailable"], [504, "Request deadline exceeded"]]) {
    responses[status] = { description, content: { "application/json": { schema: { $ref: "#/components/schemas/ApiError" } } } };
  }
}
spec.paths["/api/ready"] = { get: { summary: "Facilitator and Base RPC readiness (free, cached for 15 seconds)", security: [], responses: { "200": { description: "Both dependencies ready" }, "503": { description: "A required dependency is unavailable" } } } };
spec.components ??= {};
spec.components.schemas ??= {};
spec.components.schemas.ApiError = { type: "object", required: ["error", "code", "retryable", "retryAfter", "requestId"], properties: { error: { type: "string" }, code: { type: "string" }, retryable: { type: "boolean" }, retryAfter: { type: "integer", nullable: true }, requestId: { type: "string" } } };
spec.info.description = "Base mainnet data with x402 payments. Hosted prices: $0.001-$0.008 USDC. Self-hosted payment network and recipient are configured at startup; inspect /api/catalog and /.well-known/agent-card.json. PAYMENT-SIGNATURE sends authorization; PAYMENT-REQUIRED and PAYMENT-RESPONSE carry the quote and receipt.";
const result = JSON.stringify(spec, null, 2) + "\n";
if (process.argv.includes("--check")) {
  if (current.replace(/\r\n/g, "\n") !== result) { console.error("OpenAPI is stale; run npm run generate"); process.exitCode = 1; }
  else console.log(`OpenAPI agrees with ${ENDPOINTS.length} registered endpoints.`);
} else { writeFileSync(file, result); console.log(`Generated ${ENDPOINTS.length} OpenAPI operations.`); }
