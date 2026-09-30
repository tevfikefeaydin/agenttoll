import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { getPortfolio } from "../src/services/portfolio.js";

const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const entry = (n: number, rate: string | null) => ({
  value: "1", token: { address_hash: address(n), symbol: `T${n}`, name: `Token ${n}`, decimals: "0", exchange_rate: rate, reputation: null },
});

function mockPortfolio(t: TestContext, pages: object[]) {
  let pagesRead = 0;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("blockscout") && url.includes("/tokens?")) {
      assert.ok(pagesRead < pages.length, "must not exceed the bounded provider scan");
      return Response.json(pages[pagesRead++]);
    }
    if (url.includes("coingecko")) return Response.json({ ethereum: { usd: 2000, usd_24h_change: 0 } });
    if (["https://mainnet.base.org", "https://base-rpc.publicnode.com", "https://base.meowrpc.com"].includes(url)) {
      const rpc = JSON.parse(String(init?.body));
      return Response.json({ jsonrpc: "2.0", id: rpc.id, result: rpc.method === "eth_call" ? `0x${"0".repeat(64)}` : "0x0" });
    }
    throw new Error(`Unexpected fixture request: ${url}`);
  });
  return () => pagesRead;
}

test("a dust pagination stop reports unknown remaining holdings even when minValue is zero", async (t) => {
  const pagesRead = mockPortfolio(t, [{ items: [entry(10, "10"), entry(11, "0.5")], next_page_params: { fiat_value: "0.5", id: 11 } }]);
  const result = await getPortfolio(address(1), "0", "50");
  assert.equal(pagesRead(), 1);
  assert.equal(result.totalUsd, 10.5);
  assert.equal(result.unpriced, 0);
  assert.equal(result.partial, true);
  assert.equal(result.coverage.complete, false);
  assert.equal(result.coverage.readFloorUsd, 1);
  assert.equal(result.coverage.unscannedTokens, null);
  assert.match(result.note!, /observed holdings only.*remaining.*unknown/i);
  const filtered = await getPortfolio(address(1), "1", "50");
  assert.equal(pagesRead(), 1, "caller floors share the same bounded cached snapshot");
  assert.equal(filtered.tokenCount, 1);
  assert.equal(filtered.partial, true);
});

test("drained provider pages preserve known unpriced counts and scan completeness", async (t) => {
  const pagesRead = mockPortfolio(t, [{ items: [entry(20, "10"), entry(21, null)], next_page_params: null }]);
  const result = await getPortfolio(address(2), "0", "50");
  assert.equal(pagesRead(), 1);
  assert.equal(result.unpriced, 1);
  assert.equal(result.tokenCount, 1);
  assert.equal(result.coverage.complete, true);
  assert.equal(result.coverage.scope, "source-holdings-scan");
  assert.equal(result.coverage.unscannedTokens, 0);
  assert.equal(result.partial, undefined);
});

test("a missing fiat boundary cannot imply the remaining holdings were scanned", async (t) => {
  const pagesRead = mockPortfolio(t, [{ items: [entry(30, "10")], next_page_params: { fiat_value: null, id: 30 } }]);
  const result = await getPortfolio(address(3), "0");
  assert.equal(pagesRead(), 1);
  assert.equal(result.partial, true);
  assert.equal(result.coverage.unscannedTokens, null);
  assert.match(result.note!, /boundary is unavailable/);
});

test("the portfolio scan remains bounded at three pages and marks the remaining tail", async (t) => {
  const pagesRead = mockPortfolio(t, Array.from({ length: 3 }, (_, i) => ({
    items: [entry(40 + i, "10")], next_page_params: { fiat_value: "10", id: 40 + i },
  })));
  const result = await getPortfolio(address(4), "0");
  assert.equal(pagesRead(), 3);
  assert.equal(result.tokenCount, 3);
  assert.equal(result.partial, true);
  assert.equal(result.coverage.unscannedTokens, null);
  assert.match(result.note!, /3-page limit/);
});

test("an empty page with a continuation is an incomplete scan", async (t) => {
  mockPortfolio(t, [{ items: [], next_page_params: { fiat_value: "10", id: 50 } }]);
  const result = await getPortfolio(address(5), "0");
  assert.equal(result.partial, true);
  assert.equal(result.coverage.complete, false);
  assert.match(result.note!, /empty page/);
});
