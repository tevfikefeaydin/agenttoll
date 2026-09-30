import assert from "node:assert/strict";
import { test } from "node:test";
import { getNewTokenRadar } from "../src/services/radar.js";

const pool = { attributes: { name: "New Token / WETH", address: `0x${"1".repeat(40)}`,
  pool_created_at: "2026-09-30T12:00:00Z", base_token_price_usd: "1", volume_usd: { h24: "100" }, reserve_in_usd: "5000" },
  relationships: { base_token: { data: { id: `base_0x${"2".repeat(40)}` } } } };

test("valid low-liquidity radar pages honor each caller's floor using one cached listing", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    calls++;
    const url = String(input);
    assert.match(url, /new_pools\?page=/);
    return Response.json({ data: url.endsWith("page=1") ? [pool] : [] });
  });
  const defaults = await getNewTokenRadar();
  assert.equal(defaults.count, 0);
  const lower = await getNewTokenRadar("0", "30");
  assert.equal(lower.count, 1);
  assert.equal(lower.pools[0].liquidityUsd, 5000);
  assert.equal(lower.source, "geckoterminal-new-pools");
  assert.equal(calls, 2, "changing the floor must not reload provider pages");
});

test("a valid empty radar listing is a successful empty result", async (t) => {
  t.mock.method(Date, "now", () => Date.parse("2030-01-01T00:00:00Z"));
  t.mock.method(globalThis, "fetch", async () => Response.json({ data: [] }));
  const result = await getNewTokenRadar("0");
  assert.deepEqual(result.pools, []);
  assert.equal(result.count, 0);
});

test("invalid primary radar data still falls back to the recent-volume source", async (t) => {
  const now = Date.parse("2031-01-01T12:00:00Z");
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = String(input);
    return Response.json(url.includes("new_pools") ? { data: {} } : { data: [{ ...pool,
      attributes: { ...pool.attributes, pool_created_at: new Date(now - 1000).toISOString() } }] });
  });
  const result = await getNewTokenRadar("1000");
  assert.equal(result.count, 1);
  assert.equal(result.source, "geckoterminal-recent-volume");
});
