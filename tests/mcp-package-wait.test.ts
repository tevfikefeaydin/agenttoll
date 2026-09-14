import assert from "node:assert/strict";
import { test } from "node:test";
const { waitForNpmVersion } = await import(new URL("../scripts/mcp-package-wait.mjs", import.meta.url).href);
const version = "0.14.0";
const integrity = "sha512-" + "A".repeat(86) + "==";
const exact = { name: "agenttoll-mcp", version, dist: { integrity } };
const packument = { name: "agenttoll-mcp", versions: { [version]: exact } };

test("npm visibility waits for exact version and lagging packument without any writes", async () => {
  let calls = 0;
  let clock = 0;
  const result = await waitForNpmVersion({ version, expectedIntegrity: integrity, budgetMs: 20_000 }, {
    now: () => clock,
    sleep: async (ms: number) => { clock += ms; },
    fetchImpl: async (url: string, init: RequestInit) => {
      assert.equal(init.method, "GET");
      assert.equal(init.redirect, "error");
      assert.equal(new Headers(init.headers).has("authorization"), false);
      assert.equal(new Headers(init.headers).get("cache-control"), "no-cache");
      assert.ok(init.signal);
      calls++;
      if (calls === 1) return new Response(null, { status: 404 });
      if (url.endsWith(`/${version}`)) return Response.json(exact);
      assert.equal(new Headers(init.headers).get("accept"), "application/vnd.npm.install-v1+json");
      return Response.json(calls === 3 ? { name: "agenttoll-mcp", versions: {} } : packument);
    },
  });
  assert.equal(calls, 5);
  assert.equal(result.integrity, integrity);
  assert.equal(result.attempts, 3);
  assert.ok(clock > 0);
});

test("npm visibility absence stops at a finite total budget", async () => {
  let clock = 0;
  let calls = 0;
  await assert.rejects(waitForNpmVersion({ version, budgetMs: 10, intervalMs: 6 }, {
    now: () => clock,
    sleep: async (ms: number) => { clock += ms; },
    fetchImpl: async () => { calls++; return new Response(null, { status: 404 }); },
  }), /not publicly visible.*10ms/);
  assert.equal(clock, 10);
  assert.equal(calls, 2);
});

test("npm request deadlines cap at 15 seconds and shrink to the remaining total budget", async context => {
  const timeouts: number[] = [];
  let clock = 0;
  let calls = 0;
  context.mock.method(AbortSignal, "timeout", (ms: number) => { timeouts.push(ms); return new AbortController().signal; });
  await waitForNpmVersion({ version, budgetMs: 20_000 }, {
    now: () => clock,
    fetchImpl: async () => {
      calls++;
      if (calls === 1) { clock = 14_000; return Response.json(exact); }
      return Response.json(packument);
    },
  });
  assert.deepEqual(timeouts, [15_000, 6000]);
});

test("npm metadata body errors fail without retrying or exposing the body", async () => {
  let calls = 0;
  await assert.rejects(waitForNpmVersion({ version }, {
    fetchImpl: async () => {
      calls++;
      return { ok: true, status: 200, json: async () => { throw new Error("SECRET-aborted-body"); } };
    },
  }), (error: Error) => { assert.match(error.message, /Invalid npm visibility JSON/); assert.doesNotMatch(error.message, /SECRET/); return true; });
  assert.equal(calls, 1);
});

for (const status of [400, 401, 403, 429, 500]) {
  test(`npm visibility fails HTTP ${status} without retrying or exposing response content`, async () => {
    let calls = 0;
    await assert.rejects(waitForNpmVersion({ version }, {
      fetchImpl: async () => { calls++; return new Response("SECRET-response", { status }); },
      sleep: async () => { assert.fail("Permanent errors must not be retried"); },
    }), (error: Error) => { assert.match(error.message, new RegExp(`HTTP ${status}`)); assert.doesNotMatch(error.message, /SECRET/); return true; });
    assert.equal(calls, 1);
  });
}

test("npm visibility rejects changed artifact integrity immediately", async () => {
  let calls = 0;
  await assert.rejects(waitForNpmVersion({ version, expectedIntegrity: integrity }, {
    fetchImpl: async () => { calls++; return Response.json({ ...exact, dist: { integrity: "sha512-" + "B".repeat(86) + "==" } }); },
  }), /integrity mismatch/);
  assert.equal(calls, 1);
});

test("npm visibility rejects disagreement between exact and packument metadata", async () => {
  let calls = 0;
  await assert.rejects(waitForNpmVersion({ version }, {
    fetchImpl: async () => Response.json(++calls === 1 ? exact : { name: "agenttoll-mcp", versions: {
      [version]: { ...exact, dist: { integrity: "sha512-" + "B".repeat(86) + "==" } },
    } }),
  }), /integrity mismatch/);
  assert.equal(calls, 2);
});

test("npm visibility treats malformed metadata as corruption, not propagation delay", async () => {
  let calls = 0;
  await assert.rejects(waitForNpmVersion({ version }, {
    fetchImpl: async () => { calls++; return Response.json({ name: "agenttoll-mcp", version }); },
  }), /Invalid npm/);
  assert.equal(calls, 1);
});

test("npm visibility sanitizes a request failure and does not retry it", async () => {
  let calls = 0;
  await assert.rejects(waitForNpmVersion({ version }, {
    fetchImpl: async () => { calls++; throw new Error("SECRET-network-detail"); },
  }), (error: Error) => { assert.match(error.message, /request failed/); assert.doesNotMatch(error.message, /SECRET/); return true; });
  assert.equal(calls, 1);
});
