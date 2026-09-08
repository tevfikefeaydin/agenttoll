import assert from "node:assert/strict";
import { test } from "node:test";
import { getAddressActivity, getRadarSince, getPriceAlert } from "../src/services/watch.js";
import { deflateRawSync } from "node:zlib";

const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const tx = (n: number, timestamp = "2026-09-08T10:00:00Z") => ({
  hash: hash(n), timestamp, block_number: 100, position: n, value: "1000000000000000",
  method: "transfer", from: { hash: address(99) }, to: { hash: address(1) },
});
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

test("wallet watch resumes a 51-event window without losing the last transaction", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = new URL(String(input));
    return url.searchParams.has("block_number")
      ? json({ items: [tx(1)], next_page_params: null })
      : json({ items: Array.from({ length: 50 }, (_, i) => tx(51 - i)), next_page_params: { block_number: 100, index: 2, items_count: 50 } });
  });
  const first = await getAddressActivity(address(1), "2026-09-08T09:00:00Z");
  const second = await getAddressActivity(address(1), first.cursor);
  assert.equal(new Set([...first.events, ...second.events].map((e) => e.hash)).size, 51);
  assert.equal(first.hasMore, true);
  assert.equal(second.hasMore, false);
  assert.equal(second.events[0].hash, hash(1));
  assert.ok(first.cursor.length < 8_000);
});

test("wallet watch uses Base mainnet even when payments use Base Sepolia", async (t) => {
  const previousNetwork = process.env.NETWORK;
  process.env.NETWORK = "base-sepolia";
  t.after(() => { if (previousNetwork === undefined) delete process.env.NETWORK; else process.env.NETWORK = previousNetwork; });
  const urls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    urls.push(String(input));
    return json({ items: [], next_page_params: null });
  });
  const result = await getAddressActivity(address(2));
  assert.equal(result.chain, "base");
  assert.equal(new URL(urls[0]).host, "base.blockscout.com");
});

test("wallet backfill deduplicates overlapping provider pages older than the polling overlap", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const resumed = new URL(String(input)).searchParams.has("index");
    return resumed
      ? json({ items: [tx(20, "2026-09-07T10:00:00Z"), tx(10, "2026-09-06T10:00:00Z")], next_page_params: null })
      : json({ items: [tx(30), tx(20, "2026-09-07T10:00:00Z")], next_page_params: { block_number: 100, index: 20, items_count: 2 } });
  });
  const first = await getAddressActivity(address(6));
  const second = await getAddressActivity(address(6), first.cursor);
  assert.deepEqual(second.events.map((e) => e.hash), [hash(10)]);
});

test("wallet cursor cannot redirect pagination or expand an unbounded payload", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; throw new Error("Unexpected HTTP"); });
  const cursor = (value: object) => `w1.${deflateRawSync(JSON.stringify(value)).toString("base64url")}`;
  const state = { v: 1, address: address(7), floor: 0, watermark: 0, seen: [], replayPossible: false, next: null };
  await assert.rejects(getAddressActivity(address(7), cursor({ ...state, next: { block_number: 5, index: 1, items_count: 50, url: "https://example.com" } })), /cursor/i);
  await assert.rejects(getAddressActivity(address(7), cursor({ ...state, seen: "x".repeat(40_000) })), /cursor/i);
  assert.equal(calls, 0);
});

test("wallet watch catches delayed same-time and overlap events without replaying seen hashes", async (t) => {
  let now = Date.parse("2026-09-08T10:01:00Z");
  t.mock.method(Date, "now", () => now);
  let round = 0;
  t.mock.method(globalThis, "fetch", async () => json({
    items: round === 0 ? [tx(4)] : [tx(5), tx(4), tx(3, "2026-09-08T09:59:30Z")], next_page_params: null,
  }));
  const first = await getAddressActivity(address(3));
  now += 21_000;
  round += 1;
  const second = await getAddressActivity(address(3), first.cursor);
  assert.deepEqual(second.events.map((e) => e.hash), [hash(5), hash(3)]);
  now += 21_000;
  const third = await getAddressActivity(address(3), second.cursor);
  assert.equal(third.events.length, 0);
});

test("wallet cursor is address-bound and rejects oversized or malformed values before HTTP", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return json({ items: [tx(8)], next_page_params: null }); });
  const first = await getAddressActivity(address(4));
  await assert.rejects(getAddressActivity(address(5), first.cursor), /cursor|since/i);
  await assert.rejects(getAddressActivity(address(4), "w1." + "A".repeat(30_000)), /cursor|since/i);
  await assert.rejects(getAddressActivity(address(4), "not-a-cursor"), /cursor|since/i);
  assert.equal(calls, 1);
});

test("radar watch labels its ranked listing as partial coverage", async (t) => {
  t.mock.method(globalThis, "fetch", async () => json({ data: [{
    attributes: { name: "Pool / ETH", address: address(77), pool_created_at: "2026-09-08T10:00:00Z", base_token_price_usd: "1", volume_usd: { h24: "100" }, reserve_in_usd: "20000" },
    relationships: { base_token: { data: { id: `base_${address(78)}` } } },
  }] }));
  const result = await getRadarSince("2026-09-08T09:00:00Z");
  assert.equal(result.partial, true);
  assert.equal(result.coverage.complete, false);
  assert.match(result.coverage.note, /ranked|limited/i);
});

test("price alerts retain exchange currency assumptions from the price they compare", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) =>
    String(input).includes("coingecko") ? new Response("{}", { status: 503 }) : json({ lastPrice: "1", priceChangePercent: "0" }));
  const alert = await getPriceAlert("aero", "1", "2");
  assert.equal(alert.triggered, false);
  assert.equal(alert.source, "binance");
  assert.equal(alert.quoteCurrency, "USDT");
  assert.deepEqual(alert.assumptions, ["1 USDT = 1 USD"]);
});


test("wallet watch drains three real-shaped Blockscout pages", async (t) => {
  // Blockscout address_controller uses non-cumulative items_count; its
  // transaction cursor also includes fee/value/hash/inserted_at fields.
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const offset = Number(new URL(String(input)).searchParams.get("index") ?? 102);
    const high = offset - 1;
    const items = Array.from({ length: Math.min(50, high) }, (_, i) => tx(high - i));
    const last = items.at(-1)!;
    return json({ items, next_page_params: last.position > 1 ? {
      block_number: 100, index: last.position, items_count: 50,
      hash: last.hash, inserted_at: "2026-09-08T10:00:00Z", value: "0", fee: "1000",
    } : null });
  });
  const events: { hash: string }[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 3; page++) {
    const result = await getAddressActivity(address(50), cursor);
    events.push(...result.events); cursor = result.cursor;
    assert.equal(result.hasMore, page < 2);
  }
  assert.equal(new Set(events.map(event => event.hash)).size, 101);
});
