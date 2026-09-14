import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createAgentTollServer } from "../mcp/server.js";

test("MCP input schemas reject invalid addresses and alert bounds before HTTP", async () => {
  const server = createAgentTollServer();
  const client = new Client({ name: "schema-regression", version: "1.0.0" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const previousFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error("Input validation must precede HTTP"); };
  try {
    const { tools } = await client.listTools();
    for (const name of ["get_base_token_price", "get_base_address_info", "get_base_portfolio", "check_token_safety", "watch_base_address"]) {
      const schema = tools.find(tool => tool.name === name)!.inputSchema.properties!.address as { pattern: string };
      assert.equal(schema.pattern, "^0x[0-9a-fA-F]{40}$", name);
      const result = await client.callTool({ name, arguments: { address: "0xinvalid" } });
      assert.equal(result.isError, true, name);
    }
    for (const args of [{ symbol: "eth", ref: 0 }, { symbol: "eth", ref: -1 }, { symbol: "eth", ref: 1, pct: -1 }]) {
      const result = await client.callTool({ name: "watch_price_alert", arguments: args });
      assert.equal(result.isError, true);
    }
    assert.equal(requests, 0);
  } finally {
    globalThis.fetch = previousFetch;
    await client.close();
    await server.close();
  }
});
