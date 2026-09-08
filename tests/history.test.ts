import assert from "node:assert/strict";
import { test } from "node:test";
import { getRadarHistory, getScorecard } from "../src/services/history.js";

const revision = "ab".repeat(20);
const token = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const pool = (n: number, safety: object | null = { verdict: "clear", failed: [], warnings: [], unchecked: [] }) => ({
  name: `token ${n}`, pool: token(n + 100), token: token(n), createdAt: "2026-09-05T08:00:00Z",
  priceUsd: 1, liquidityUsd: 20_000, volume24hUsd: 1000, safety,
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

test("scorecard averages the middle two values and preserves missing-price and missing-snapshot coverage", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("api.github.com")) return json({ sha: revision });
    if (url.endsWith("index.json")) return json({ dates: ["2026-09-05", "2026-09-06"] });
    if (url.endsWith("2026-09-05.json")) return json({ date: "2026-09-05", at: "2026-09-05T10:00:00Z", settlement: null, summary: {}, pools: [pool(1), pool(2), pool(3), pool(4, null)] });
    if (url.endsWith("2026-09-06.json")) return json({}, 404);
    if (url.includes("dexscreener")) return json([
      { chainId: "base", baseToken: { address: token(1) }, priceUsd: "1", liquidity: { usd: 10_000 } },
      { chainId: "base", baseToken: { address: token(2) }, priceUsd: "2", liquidity: { usd: 10_000 } },
    ]);
    throw new Error(`Unexpected fixture URL ${url}`);
  });
  const result = await getScorecard("2");
  assert.equal(result.cohorts.clear.medianChangePct, 50);
  const missing = result.tokens.find((p) => p.token === token(3))!;
  assert.equal(missing.liquidityGone, null);
  assert.equal(missing.liquidityNowUsd, null);
  assert.equal(missing.priceChangePct, null);
  assert.equal(missing.outcome, "unavailable");
  assert.equal(result.cohorts.clear.count, 3);
  assert.equal(result.cohorts.clear.priced, 2);
  assert.equal(result.cohorts.clear.unavailable, 1);
  assert.equal(result.coverage.snapshotsLoaded, 1);
  assert.deepEqual(result.coverage.missingSnapshotDates, ["2026-09-06"]);
  assert.equal(result.coverage.poolsWithoutSafety, 1);
  assert.equal(result.trackRecord.daysCovered, 1);
});

test("history pins both index and snapshot to one immutable revision and reports honest provenance", async (t) => {
  const urls: string[] = [];
  t.mock.method(Date, "now", () => Date.parse("2030-01-01T00:00:00Z"));
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = String(input); urls.push(url);
    if (url.includes("api.github.com")) return json({ sha: revision });
    if (url.endsWith("index.json")) return json({ dates: ["2026-09-07"] });
    return json({ date: "2026-09-07", at: "2026-09-07T10:00:00Z", settlement: `0x${"12".repeat(32)}`, summary: {}, pools: [] });
  });
  const result = await getRadarHistory();
  assert.ok(urls.filter((url) => url.includes("raw.githubusercontent")).every((url) => url.includes(`/${revision}/`)));
  assert.equal(result.provenance.revision, revision);
  assert.equal(result.provenance.commit, `https://github.com/tevfikefeaydin/agenttoll/commit/${revision}`);
  assert.match(result.provenance.integrity, /not.*hash|does not.*hash/i);
});

test("scorecard preserves valid observations when a price response contains malformed pairs", async (t) => {
  t.mock.method(Date, "now", () => Date.parse("2031-01-01T00:00:00Z"));
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("api.github.com")) return json({ sha: "cd".repeat(20) });
    if (url.endsWith("index.json")) return json({ dates: ["2026-09-07"] });
    if (url.includes("dexscreener")) return json([null,
      { chainId: "base", baseToken: { address: token(5) }, priceUsd: "1", liquidity: { usd: 10_000 } },
      { chainId: "base", baseToken: { address: token(6) }, priceUsd: "0.5", liquidity: { usd: 0 } },
      { chainId: "base", baseToken: { address: token(7) }, priceUsd: "1" },
    ]);
    return json({ date: "2026-09-07", at: "2026-09-07T10:00:00Z", settlement: null, summary: {}, pools: [pool(5), pool(6), pool(7)] });
  });
  const result = await getScorecard("1");
  assert.equal(result.cohorts.clear.medianChangePct, 0);
  assert.equal(result.cohorts.clear.priced, 1);
  assert.equal(result.cohorts.clear.liquidityGone, 1);
  assert.equal(result.cohorts.clear.unavailable, 1);
  assert.equal(result.tokens.find((entry) => entry.token === token(6))!.liquidityGone, true);
  assert.equal(result.tokens.find((entry) => entry.token === token(7))!.liquidityGone, null);
});

test("history fails explicitly when an immutable revision cannot be resolved", async (t) => {
  t.mock.method(Date, "now", () => Date.parse("2032-01-01T00:00:00Z"));
  t.mock.method(globalThis, "fetch", async () => json({ sha: "main" }));
  await assert.rejects(getRadarHistory(), /immutable.*revision/i);
});

test("scorecard handles empty, singleton and odd cohorts while retaining the first unassessed sighting", async (t) => {
  t.mock.method(Date, "now", () => Date.parse("2033-01-01T00:00:00Z"));
  const safety = (verdict: string) => ({ verdict, failed: [], warnings: [], unchecked: [] });
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("api.github.com")) return json({ sha: "ef".repeat(20) });
    if (url.endsWith("index.json")) return json({ dates: ["2026-09-06", "2026-09-07"] });
    if (url.includes("dexscreener")) return json([10, 11, 12, 13, 14].map((n, i) => ({
      chainId: "base", baseToken: { address: token(n) }, priceUsd: String([1, 2, 4, 3, 2][i]), liquidity: { usd: 10_000 },
    })));
    const date = url.includes("2026-09-06") ? "2026-09-06" : "2026-09-07";
    return json({ date, at: `${date}T10:00:00Z`, settlement: null, summary: {}, pools: date === "2026-09-06"
      ? [pool(10, safety("caution")), pool(11, safety("caution")), pool(12, safety("caution")), pool(13), pool(14, null)]
      : [pool(14)] });
  });
  const result = await getScorecard("2");
  assert.equal(result.cohorts.caution.medianChangePct, 100);
  assert.equal(result.cohorts.clear.medianChangePct, 200);
  assert.equal(result.cohorts["high-risk"].medianChangePct, null);
  assert.equal(result.cohorts.unassessed.count, 1);
  assert.equal(result.tokens.find((entry) => entry.token === token(14))!.flaggedOn, "2026-09-06");
});

test("a price source outage leaves outcomes unavailable and exposes the failed batch", async (t) => {
  t.mock.method(Date, "now", () => Date.parse("2034-01-01T00:00:00Z"));
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("api.github.com")) return json({ sha: "aa".repeat(20) });
    if (url.endsWith("index.json")) return json({ dates: ["2026-09-07"] });
    if (url.includes("dexscreener")) return json({}, 503);
    return json({ date: "2026-09-07", at: "2026-09-07T10:00:00Z", settlement: null, summary: {}, pools: [pool(20)] });
  });
  const result = await getScorecard("1");
  assert.equal(result.tokens[0].outcome, "unavailable");
  assert.equal(result.tokens[0].liquidityGone, null);
  assert.equal(result.cohorts.clear.medianChangePct, null);
  assert.equal(result.coverage.priceBatchesFailed, 1);
});


test("cohort medians round only the aggregate, not each observation", async (t) => {
  t.mock.method(Date, "now", () => Date.parse("2035-01-01T00:00:00Z"));
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("api.github.com")) return json({ sha: "12".repeat(20) });
    if (url.endsWith("index.json")) return json({ dates: ["2026-09-07"] });
    if (url.includes("dexscreener")) return json([1.00044, 1.00054].map((price, i) => ({ baseToken: { address: token(30 + i) }, priceUsd: String(price), liquidity: { usd: 1000 } })));
    return json({ date: "2026-09-07", at: "2026-09-07T10:00:00Z", settlement: null, summary: {}, pools: [pool(30), pool(31)] });
  });
  assert.equal((await getScorecard("1")).cohorts.clear.medianChangePct, 0);
});

test("cancelled snapshot loads reject and a healthy retry can populate the scorecard", async (t) => {
  const { requestContext } = await import("../src/request-context.js");
  t.mock.method(Date, "now", () => Date.parse("2036-01-01T00:00:00Z"));
  const controller = new AbortController();
  let cancel = true;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("api.github.com")) return json({ sha: "34".repeat(20) });
    if (url.endsWith("index.json")) return json({ dates: ["2026-09-07"] });
    if (url.includes("dexscreener")) return json([{ baseToken: { address: token(40) }, priceUsd: "2", liquidity: { usd: 1000 } }]);
    if (cancel) { controller.abort(new DOMException("expired", "TimeoutError")); throw controller.signal.reason; }
    return json({ date: "2026-09-07", at: "2026-09-07T10:00:00Z", settlement: null, summary: {}, pools: [pool(40)] });
  });
  await requestContext.run({ requestId: "cancel-test", signal: controller.signal, upstreamCalls: 0, cacheHits: 0, cacheMisses: 0, coalescedLoads: 0 }, async () => {
    await assert.rejects(getScorecard("1"), { name: "TimeoutError" });
  });
  cancel = false;
  assert.equal((await getScorecard("1")).tokens.length, 1);
});
