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

test("zero and positive low liquidity remain valid for both numeric provider representations", async (t) => {
  t.mock.method(Date, "now", () => Date.parse("2032-01-01T12:00:00Z"));
  const liquidity = [0, "0", 0.01, "0.5", 100, "5000"];
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    calls++;
    const url = String(input);
    assert.match(url, /new_pools\?page=/);
    return Response.json({ data: url.endsWith("page=1")
      ? liquidity.map(value => ({ ...pool, attributes: { ...pool.attributes, reserve_in_usd: value } })) : [] });
  });
  assert.equal((await getNewTokenRadar()).count, 0);
  const result = await getNewTokenRadar("0");
  assert.equal(result.source, "geckoterminal-new-pools");
  assert.deepEqual(result.pools.map(p => p.liquidityUsd), [0, 0, 0.01, 0.5, 100, 5000]);
  assert.equal(calls, 2, "the cached valid listing must serve both caller floors");
});

test("malformed primary liquidity falls back instead of caching a successful empty listing", async (t) => {
  const cases: [string, unknown][] = [
    ["nonnumeric", "broken"], ["empty", ""], ["whitespace", " \t\n"],
    ["null", null], ["missing", undefined], ["false", false], ["true", true],
    ["object", {}], ["empty array", []], ["numeric array", [20000]],
    ["NaN", "NaN"], ["infinity", "Infinity"], ["overflow", "1e309"],
    ["negative string", "-1"], ["negative number", -1],
  ];
  for (const [index, [label, value]] of cases.entries()) {
    await t.test(label, async (t) => {
      const now = Date.parse("2033-01-01T12:00:00Z") + index * 600_000;
      t.mock.method(Date, "now", () => now);
      let calls = 0;
      t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
        calls++;
        const url = String(input);
        if (url.includes("new_pools")) return Response.json({ data: url.endsWith("page=1")
          ? [{ ...pool, attributes: { ...pool.attributes, reserve_in_usd: value } }] : [] });
        assert.match(url, /pools\?sort=h24_volume_usd_desc&page=1$/);
        return Response.json({ data: [{ ...pool, attributes: { ...pool.attributes,
          reserve_in_usd: "20000", pool_created_at: new Date(now - 1000).toISOString() } }] });
      });
      const result = await getNewTokenRadar();
      assert.equal(result.source, "geckoterminal-recent-volume");
      assert.equal(result.count, 1);
      assert.equal(result.pools[0].liquidityUsd, 20000);
      const lower = await getNewTokenRadar("0");
      assert.deepEqual(lower.pools, result.pools);
      assert.equal(calls, 3, "cache the valid fallback instead of the malformed primary");
    });
  }
});

test("a malformed pool cannot be hidden by valid primary liquidity", async (t) => {
  const now = Date.parse("2034-01-01T12:00:00Z");
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = String(input);
    const valid = { ...pool, attributes: { ...pool.attributes, reserve_in_usd: "20000",
      pool_created_at: new Date(now - 1000).toISOString() } };
    if (url.includes("new_pools")) return Response.json({ data: url.endsWith("page=1")
      ? [valid, { ...pool, attributes: { ...pool.attributes, reserve_in_usd: "broken" } }] : [] });
    return Response.json({ data: [valid] });
  });
  const result = await getNewTokenRadar();
  assert.equal(result.source, "geckoterminal-recent-volume");
  assert.equal(result.count, 1);
});
