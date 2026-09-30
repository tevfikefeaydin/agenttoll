import assert from "node:assert/strict";
import { test } from "node:test";
import { getPrice } from "../src/services/prices.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

test("USDT exchange fallback inverts both USDCUSDT price and percentage change", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("coingecko")) return json({}, 503);
    assert.match(url, /symbol=USDCUSDT/);
    return json({ lastPrice: "1.1", priceChangePercent: "10" });
  });
  const result = await getPrice("usdt");
  assert.ok(Math.abs(result.usd - 0.9090909090909091) < 1e-12);
  assert.ok(Math.abs(result.change24h! - -9.090909090909092) < 1e-10);
  assert.equal(result.quoteCurrency, "USDC");
  assert.deepEqual(result.assumptions, ["1 USDC = 1 USD"]);
});

test("normal USDT exchange quotes disclose their dollar parity assumption", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) =>
    String(input).includes("coingecko") ? json({}, 503) : json({ lastPrice: "2000", priceChangePercent: "NaN" }));
  const result = await getPrice("eth");
  assert.equal(result.usd, 2000);
  assert.equal(result.change24h, null);
  assert.equal(result.quoteCurrency, "USDT");
  assert.deepEqual(result.assumptions, ["1 USDT = 1 USD"]);
});

test("invalid nonpositive CoinGecko quotes fall through to a valid source", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) =>
    String(input).includes("coingecko") ? json({ bitcoin: { usd: -10, usd_24h_change: 5 } }) : json({ lastPrice: "50", priceChangePercent: "0" }));
  const result = await getPrice("btc");
  assert.equal(result.usd, 50);
  assert.equal(result.source, "binance");
});

test("zero or nonfinite exchange quotes fall through to a real USD quote", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("coingecko")) return json({ solana: { usd: null } });
    if (url.includes("binance")) return json({ lastPrice: "Infinity", priceChangePercent: "0" });
    return json({ data: { amount: "120" } });
  });
  const result = await getPrice("sol");
  assert.equal(result.usd, 120);
  assert.equal(result.source, "coinbase");
  assert.equal(result.quoteCurrency, "USD");
  assert.deepEqual(result.assumptions, []);
  assert.equal(result.change24h, null);
});


test("whitespace percentage data stays unknown", async (t) => {
  t.mock.method(globalThis, "fetch", async () => json({ chainlink: { usd: 10, usd_24h_change: "   " } }));
  assert.equal((await getPrice("link")).change24h, null);
});

test("concurrent ticker and CoinGecko-ID requests share a price without sharing the requested symbol", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return json({ arbitrum: { usd: 1, usd_24h_change: 2 } }); });
  const [ticker, id] = await Promise.all([getPrice("ARB"), getPrice("arbitrum")]);
  assert.equal(calls, 1);
  assert.equal(ticker.symbol, "arb");
  assert.equal(id.symbol, "arbitrum");
  assert.equal(ticker.id, id.id);
  assert.equal(ticker.at, id.at);
  assert.equal((await getPrice("arbitrum")).symbol, "arbitrum");
  assert.equal((await getPrice("arb")).symbol, "arb");
  assert.equal(calls, 1);
});

test("canonical-ID-first cache entries still return the later caller's ticker", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return json({ optimism: { usd: 2, usd_24h_change: 0 } }); });
  assert.equal((await getPrice("optimism")).symbol, "optimism");
  assert.equal((await getPrice("OP")).symbol, "op");
  assert.equal(calls, 1);
});
