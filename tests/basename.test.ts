import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { decodeFunctionData, encodeAbiParameters, namehash, parseAbi } from "viem";
import { primaryName, resolveBasename } from "../src/services/basename.js";

const ZERO = "0x0000000000000000000000000000000000000000";
const RESOLVER = "0x2222222222222222222222222222222222222222";
const OTHER = "0x3333333333333333333333333333333333333333";
const ABI = parseAbi([
  "function resolver(bytes32 node) view returns (address)",
  "function owner(bytes32 node) view returns (address)",
  "function addr(bytes32 node) view returns (address)",
  "function name(bytes32 node) view returns (string)",
  "function text(bytes32 node, string key) view returns (string)",
]);
let nextAddress = 200;
const address = () => `0x${(nextAddress++).toString(16).padStart(40, "0")}` as `0x${string}`;

function rpc(t: TestContext, fixture: {
  name: string; address: `0x${string}`; forwardResolver?: boolean; forwardFailure?: boolean;
}) {
  const calls: string[] = [];
  const forwardNode = /^[a-z0-9-]+\.base\.eth$/.test(fixture.name) ? namehash(fixture.name) : null;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    assert.ok(["https://mainnet.base.org", "https://base-rpc.publicnode.com", "https://base.meowrpc.com"].includes(new URL(String(input)).origin));
    const body = JSON.parse(String(init?.body));
    assert.equal(body.method, "eth_call");
    const decoded = decodeFunctionData({ abi: ABI, data: body.params[0].data });
    calls.push(decoded.functionName);
    let result: `0x${string}`;
    if (decoded.functionName === "name") {
      result = encodeAbiParameters([{ type: "string" }], [fixture.name]);
    } else if (decoded.functionName === "text") {
      result = encodeAbiParameters([{ type: "string" }], [""]);
    } else if (decoded.functionName === "addr") {
      if (fixture.forwardFailure) {
        return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32000, message: "execution reverted" } });
      }
      result = encodeAbiParameters([{ type: "address" }], [fixture.address]);
    } else {
      const missing = decoded.functionName === "resolver" && decoded.args[0] === forwardNode && fixture.forwardResolver === false;
      result = encodeAbiParameters([{ type: "address" }], [missing ? ZERO : RESOLVER]);
    }
    return Response.json({ jsonrpc: "2.0", id: body.id, result });
  });
  return calls;
}

test("a reverse name belonging to another address is never returned as a primary name", async (t) => {
  const queried = address();
  const calls = rpc(t, { name: "someone-else.base.eth", address: OTHER });
  const result = await resolveBasename(queried);
  assert.equal(result.name, null);
  assert.equal(result.hasPrimaryName, false);
  assert.equal(result.address, queried);
  assert.equal(result.verification, "mismatch");
  assert.ok(calls.includes("addr"), "The claimed name must be forward resolved");
});

test("a reverse name is displayed when its forward address matches", async (t) => {
  const queried = address();
  const calls = rpc(t, { name: "matched.base.eth", address: queried });
  const result = await resolveBasename(queried);
  assert.equal(result.name, "matched.base.eth");
  assert.equal(result.hasPrimaryName, true);
  assert.equal(result.verification, "verified");
  assert.deepEqual(calls, ["resolver", "name", "resolver", "addr"]);
});

test("forward name lookups still return the address and optional records", async (t) => {
  const resolved = address();
  rpc(t, { name: "forward.base.eth", address: resolved });
  const result = await resolveBasename("forward");
  assert.equal(result.name, "forward.base.eth");
  assert.equal(result.address?.toLowerCase(), resolved);
  assert.equal(result.registered, true);
  assert.deepEqual(result.records, {});
});

test("primaryName enrichment uses the same forward verification", async (t) => {
  rpc(t, { name: "spoofed.base.eth", address: OTHER });
  assert.equal(await primaryName(address()), null);
});

test("a forward name that lowercases to an address cannot populate the reverse cache", async (t) => {
  const queried = address();
  let requests = 0;
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    requests++;
    const body = JSON.parse(String(init?.body));
    const decoded = decodeFunctionData({ abi: ABI, data: body.params[0].data });
    assert.equal(decoded.functionName, "resolver");
    return Response.json({ jsonrpc: "2.0", id: body.id, result: encodeAbiParameters([{ type: "address" }], [ZERO]) });
  });
  const forward = await resolveBasename(`0X${queried.slice(2)}`);
  assert.equal(forward.registered, false);
  assert.equal(forward.name, `${queried}.base.eth`);
  const reverse = await resolveBasename(queried);
  assert.equal(reverse.name, null);
  assert.equal(reverse.verification, "no-name");
  assert.equal(reverse.address, queried);
  assert.equal(await primaryName(queried), null);
  assert.equal(requests, 2, "The reverse lookup must make its own resolver read");
});

test("name enrichment rejects cached results without the complete identity proof", async (t) => {
  for (const changes of [
    { hasPrimaryName: false },
    { verification: "unavailable" as const },
    { address: OTHER },
  ]) {
    await t.test(JSON.stringify(changes), async (sub) => {
      const queried = address();
      rpc(sub, { name: "proof.base.eth", address: queried });
      const result = await resolveBasename(queried);
      assert.equal(await primaryName(queried), "proof.base.eth");
      // A public result is the same object held by the cache. Enrichment must
      // validate the proof it consumes, even when a cached result is corrupted.
      Object.assign(result, changes);
      assert.equal(await primaryName(queried), null);
    });
  }
});

test("a missing forward resolver leaves the primary name unverified", async (t) => {
  rpc(t, { name: "missing.base.eth", address: OTHER, forwardResolver: false });
  const result = await resolveBasename(address());
  assert.equal(result.name, null);
  assert.equal(result.hasPrimaryName, false);
});

test("a failed forward read cannot fall back to the unverified reverse name", async (t) => {
  rpc(t, { name: "failed.base.eth", address: OTHER, forwardFailure: true });
  const result = await resolveBasename(address());
  assert.equal(result.name, null);
  assert.equal(result.hasPrimaryName, false);
  assert.equal(result.verification, "unavailable");
});

test("reverse claims outside the basename namespace are not rewritten into a different name", async (t) => {
  rpc(t, { name: "someone.eth", address: OTHER });
  const result = await resolveBasename(address());
  assert.equal(result.name, null);
  assert.equal(result.hasPrimaryName, false);
});

test("a zero forward address cannot verify a primary name", async (t) => {
  rpc(t, { name: "zero.base.eth", address: ZERO });
  const result = await resolveBasename(address());
  assert.equal(result.name, null);
  assert.equal(result.hasPrimaryName, false);
});

test("unavailable RPCs are tried only once each", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response("Unavailable", { status: 503 });
  });
  assert.equal(await primaryName(address()), null);
  assert.ok(calls <= 3, `Resolver repeated the three-provider fallback: ${calls} requests`);
});

test("a hanging RPC is aborted and name enrichment completes within a bounded deadline", async (t) => {
  const pending: Array<() => void> = [];
  let released = false;
  let aborted = 0;
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (!released) {
      await new Promise<void>((resolve, reject) => {
        pending.push(resolve);
        const onAbort = () => { aborted++; reject(init?.signal?.reason ?? new Error("Aborted")); };
        if (init?.signal?.aborted) onAbort();
        else init?.signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
    return Response.json({ jsonrpc: "2.0", id: body.id, result: encodeAbiParameters([{ type: "address" }], [ZERO]) });
  });
  const lookup = primaryName(address());
  const timeout = new AbortController();
  const result = await Promise.race([
    lookup.then((name) => ({ completed: true, name })),
    delay(7_000, { completed: false, name: null }, { signal: timeout.signal }).catch(() => ({ completed: false, name: null })),
  ]);
  released = true;
  for (const release of pending) release();
  timeout.abort();
  await lookup;
  assert.equal(result.completed, true, "Hanging resolver exceeded seven seconds");
  assert.equal(result.name, null);
  assert.ok(aborted > 0, "The underlying RPC request must be cancelled");
});
