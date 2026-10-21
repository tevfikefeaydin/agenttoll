import assert from "node:assert/strict";
import { test } from "node:test";
import { addressRisk, ownerInterface, poolEvidence } from "../src/services/safety-evidence.js";
import { requestContext } from "../src/request-context.js";

const TOKEN = "0x2222222222222222222222222222222222222222";
const IMPLEMENTATION = "0x3333333333333333333333333333333333333333";
const cleanRisk = () => Object.fromEntries([
  "cybercrime", "money_laundering", "financial_crime", "phishing_activities", "stealing_attack", "blackmail_activities",
  "malicious_mining_activities", "fake_token", "honeypot_related_address", "gas_abuse", "darkweb_transactions", "reinit",
  "fake_kyc", "blacklist_doubt", "fake_standard_interface", "sanctioned", "mixer", "number_of_malicious_contracts_created",
].map(key => [key, "0"]));

test("address screening requires explicit values and distinguishes context from malicious activity", async t => {
  let result: Record<string, unknown> = cleanRisk();
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    assert.equal(String(url), `https://api.gopluslabs.io/api/v1/address_security/${TOKEN}?chain_id=8453`);
    return Response.json({ code: 1, result });
  });
  assert.equal((await addressRisk(TOKEN, [])).complete, true);
  result.mixer = "1"; result.sanctioned = "1"; result.blacklist_doubt = "1";
  const context = await addressRisk(TOKEN, []);
  assert.deepEqual(context.riskFlags, []);
  assert.equal(context.reviewFlags.length, 3);
  result.phishing_activities = "1"; result.number_of_malicious_contracts_created = "2";
  const flagged = await addressRisk(TOKEN, []);
  assert.deepEqual(flagged.riskFlags, ["phishing_activities", "number_of_malicious_contracts_created"]);
  result = {};
  const empty = await addressRisk(TOKEN, []);
  assert.equal(empty.complete, false);
  assert.equal(empty.missing.length, 18);
});

test("invalid flags and counts stay missing while a positive finding survives", async t => {
  for (const invalid of [null, "", true, {}, [], "false", "-1", "0.1", "Infinity"]) {
    const result = { ...cleanRisk(), phishing_activities: "1", mixer: invalid, number_of_malicious_contracts_created: invalid };
    t.mock.method(globalThis, "fetch", async () => Response.json({ code: 1, result }));
    const issues: string[] = [];
    const risk = await addressRisk(TOKEN, issues);
    assert.equal(risk.complete, false);
    assert.deepEqual(risk.riskFlags, ["phishing_activities"]);
    assert.deepEqual(issues, ["mixer", "number_of_malicious_contracts_created"]);
    t.mock.restoreAll();
  }
});

test("failed provider envelope is rejected without leaking provider message", async t => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ code: -1, result: cleanRisk(), message: "private-upstream-details" }));
  await assert.rejects(addressRisk(TOKEN, []), { message: "response" });
});

test("verified interface follows one same-chain implementation and exposes only allowlisted method names", async t => {
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); calls.push(url);
    assert.ok(init?.signal);
    const root = url.includes(TOKEN);
    return Response.json({ chainId: "8453", address: root ? TOKEN : IMPLEMENTATION, runtimeMatch: "exact_match",
      abi: [{ type: "function", name: root ? "upgradeTo" : "mint" }, { type: "function", name: "private-arbitrary-provider-text" }],
      proxyResolution: { isProxy: root, implementations: root ? [{ address: IMPLEMENTATION }] : [] },
      compilation: { fullyQualifiedName: "private/source/path" },
    });
  });
  const data = await ownerInterface(TOKEN, []);
  assert.deepEqual(data, { isProxy: true, methods: ["mint", "upgradeTo"], implementationInspected: true });
  assert.equal(calls.length, 2);
  assert.ok(calls.every(url => url.startsWith("https://sourcify.dev/server/v2/contract/8453/")));
  assert.ok(!JSON.stringify(data).includes("private"));
});

test("wrong chain, wrong address and unverified ABI cannot become interface evidence", async t => {
  for (const invalid of [{ chainId: "1" }, { address: IMPLEMENTATION }, { runtimeMatch: null }, { abi: {} }]) {
    t.mock.method(globalThis, "fetch", async () => Response.json({ chainId: "8453", address: TOKEN, runtimeMatch: "exact_match", abi: [], ...invalid }));
    await assert.rejects(ownerInterface(TOKEN, []), { message: "verified-interface" });
    t.mock.restoreAll();
  }
});

test("failed or ambiguous implementation lookup preserves only partial proxy evidence", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    if (calls > 1) return new Response("private-body", { status: 503 });
    return Response.json({ chainId: "8453", address: TOKEN, runtimeMatch: "exact_match", abi: [{ type: "function", name: "upgradeTo" }],
      proxyResolution: { isProxy: true, implementations: [{ address: IMPLEMENTATION }] } });
  });
  const issues: string[] = [];
  const data = await ownerInterface(TOKEN, issues);
  assert.equal(data?.implementationInspected, false);
  assert.deepEqual(data?.methods, ["upgradeTo"]);
  assert.deepEqual(issues, ["implementation-interface"]);
});

test("pool summary filters chain and token, deduplicates pools and never infers locks", async t => {
  const pair = { chainId: "base", pairAddress: IMPLEMENTATION, baseToken: { address: TOKEN }, quoteToken: { address: IMPLEMENTATION }, liquidity: { usd: 100 } };
  const quotePair = { ...pair, pairAddress: TOKEN, baseToken: { address: IMPLEMENTATION }, quoteToken: { address: TOKEN }, liquidity: { usd: 25 } };
  t.mock.method(globalThis, "fetch", async () => Response.json([pair, pair, quotePair, { ...pair, chainId: "ethereum" },
    { ...pair, baseToken: { address: IMPLEMENTATION } }]));
  const data = await poolEvidence(TOKEN, []);
  assert.deepEqual(data, { observedPools: 2, poolsWithLiquidity: 2, reportedLiquidityUsd: 125 });
  assert.ok(!JSON.stringify(data).includes("lock"));
});

test("conflicting, missing, and malformed liquidity is not zero or a complete total", async t => {
  const pair = { chainId: "base", pairAddress: IMPLEMENTATION, baseToken: { address: TOKEN }, liquidity: { usd: 100 } };
  t.mock.method(globalThis, "fetch", async () => Response.json([pair, { ...pair, liquidity: { usd: 500 } },
    { ...pair, pairAddress: TOKEN, liquidity: { usd: "100" } }]));
  const issues: string[] = [];
  assert.deepEqual(await poolEvidence(TOKEN, issues), { observedPools: 2, poolsWithLiquidity: 0, reportedLiquidityUsd: null });
  assert.ok(issues.includes("conflicting-pool-liquidity"));
  assert.ok(issues.includes("pool-liquidity"));
});

test("new sources honor parent cancellation before contacting a provider", async t => {
  const controller = new AbortController(); controller.abort();
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return Response.json({}); });
  await requestContext.run({ requestId: "test", signal: controller.signal, upstreamCalls: 0, cacheHits: 0, cacheMisses: 0, coalescedLoads: 0 }, async () => {
    for (const load of [addressRisk, ownerInterface, poolEvidence]) await assert.rejects(load(TOKEN, []));
  });
  assert.equal(calls, 0);
});

test("an in-flight request inherits cancellation and stops reading the source", async t => {
  const controller = new AbortController();
  t.mock.method(globalThis, "fetch", async (_url: string | URL | Request, init?: RequestInit) => {
    assert.ok(init?.signal);
    return new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
      controller.abort(new Error("caller-disconnected"));
    });
  });
  await requestContext.run({ requestId: "test", signal: controller.signal, upstreamCalls: 0, cacheHits: 0, cacheMisses: 0, coalescedLoads: 0 }, async () => {
    await assert.rejects(addressRisk(TOKEN, []), /caller-disconnected/);
  });
});

test("ambiguous proxy implementations do not expand into arbitrary lookups", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return Response.json({ chainId: "8453", address: TOKEN, runtimeMatch: "exact_match", abi: [],
      proxyResolution: { isProxy: true, implementations: [{ address: IMPLEMENTATION }, { address: "https://private.invalid" }] } });
  });
  const issues: string[] = [];
  const evidence = await ownerInterface(TOKEN, issues);
  assert.equal(calls, 1);
  assert.equal(evidence?.implementationInspected, false);
  assert.deepEqual(issues, ["implementation-interface"]);
});
