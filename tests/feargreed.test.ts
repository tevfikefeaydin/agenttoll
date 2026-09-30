import assert from "node:assert/strict";
import { test } from "node:test";
import { getFearGreed } from "../src/services/feargreed.js";

const observedAt = "2026-09-29T00:00:00.000Z";
const reading = (timestamp: unknown = String(Date.parse(observedAt) / 1000)) => ({ value: "50", value_classification: "Neutral", timestamp });

test("cached sentiment retains its provider observation and fetch timestamps", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return Response.json({ data: [reading(), { ...reading(), value: "40" }] }); });
  const first = await getFearGreed();
  const repeated = await getFearGreed("1");
  assert.equal(calls, 1);
  assert.equal(first.at, observedAt);
  assert.equal(repeated.at, observedAt);
  assert.equal(first.fetchedAt, repeated.fetchedAt);
  assert.equal(first.yesterday, 40);
  assert.ok("history" in repeated);
  assert.equal(repeated.history[0].date, observedAt);
});

for (const [i, timestamp] of [undefined, null, "", "not-a-date", "-1", true, "Infinity", "999999999999999999"].entries()) {
  test(`unavailable sentiment timestamp ${i + 1} remains null in current and history data`, async (t) => {
    t.mock.method(Date, "now", () => Date.parse("2030-01-01T00:00:00Z") + i * 600_000);
    t.mock.method(globalThis, "fetch", async () => Response.json({ data: [{ value: "0", value_classification: "Extreme Fear", timestamp }] }));
    const result = await getFearGreed("1");
    assert.equal(result.value, 0);
    assert.equal(result.at, null);
    assert.ok("history" in result);
    assert.equal(result.history[0].date, null);
    assert.ok(Number.isFinite(Date.parse(result.fetchedAt)));
  });
}

test("a future sentiment timestamp cannot claim a future observation", async (t) => {
  const now = Date.parse("2031-01-01T00:00:00Z");
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "fetch", async () => Response.json({ data: [reading(String(now / 1000 + 86400))] }));
  assert.equal((await getFearGreed()).at, null);
});

test("invalid sentiment values fail before they can enter the readings cache", async (t) => {
  t.mock.method(Date, "now", () => Date.parse("2032-01-01T00:00:00Z"));
  let value: unknown = "101";
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return Response.json({ data: [{ ...reading(), value }] }); });
  for (value of ["101", "-1", "garbage", "", null, true, "1.5"]) {
    await assert.rejects(getFearGreed(), /Invalid sentiment reading/);
  }
  value = "100";
  assert.equal((await getFearGreed()).value, 100);
  assert.equal(calls, 8, "invalid responses must not be cached");
});
