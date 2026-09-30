import assert from "node:assert/strict";
import { test } from "node:test";
import { fromChain, getStats, scanTollLogs } from "../src/services/stats.js";

const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const hosted = address(1);
const payer = address(99);
const baseline = { network: "base", payTo: hosted, block: 100, firstTollAt: null, lastTollAt: null, payers: { [payer]: { calls: 7, usdcUnits: "7000" } } };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

test("custom stats do not inherit a hosted baseline or another recipient's cache", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("raw.githubusercontent")) return json(baseline);
    if (url.includes("blockscout")) return json({ items: url.includes(hosted) ? Array.from({ length: 7 }, () => ({ total: { value: "1000" }, from: { hash: payer } })) : [], next_page_params: null });
    const body = JSON.parse(String(init?.body));
    return json({ result: body.method === "eth_blockNumber" ? "0x64" : [] });
  });
  const custom = await getStats(address(2), "base");
  assert.equal(custom.tollsCollected, 0);
  const hostedStats = await getStats(hosted, "base");
  assert.equal(hostedStats.tollsCollected, 7);
  const another = await getStats(address(3), "base");
  assert.equal(another.tollsCollected, 0);
});

test("testnet statistics have separate cache and a mismatched baseline never triggers a chain scan", async (t) => {
  let rpcCalls = 0;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("raw.githubusercontent")) return json(baseline);
    if (url.includes("blockscout")) return json({ items: [], next_page_params: null });
    rpcCalls++;
    return json({ result: "0x64" });
  });
  const result = await getStats(hosted, "base-sepolia");
  assert.equal(result.network, "base-sepolia");
  assert.equal(result.tollsCollected, 0);
  await assert.rejects(fromChain(address(4), "base"), /baseline.*(network|recipient|payTo)|incompatible|no compatible/i);
  await assert.rejects(fromChain(hosted, "base-sepolia"), /baseline.*(network|recipient|payTo)|incompatible|no compatible/i);
  assert.equal(rpcCalls, 0);
});

test("explicit testnet log reads use its RPC and USDC contract", async (t) => {
  let host = "";
  let contract = "";
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    host = new URL(String(input)).host;
    contract = JSON.parse(String(init?.body)).params[0].address;
    return json({ result: [] });
  });
  assert.deepEqual(await scanTollLogs(hosted, 100, 101, "base-sepolia"), []);
  assert.equal(host, "sepolia.base.org");
  assert.equal(contract.toLowerCase(), "0x036cbd53842c5426634e7929541ec2318f3dcf7e");
});

test("a compatible baseline adds only qualifying logs from the requested network", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).includes("raw.githubusercontent")) return json(baseline);
    assert.equal(new URL(String(input)).host, "mainnet.base.org");
    const request = JSON.parse(String(init?.body));
    if (request.method === "eth_blockNumber") return json({ result: "0x66" });
    if (request.method === "eth_getBlockByNumber") return json({ result: { timestamp: "0x64" } });
    assert.equal(request.method, "eth_getLogs");
    assert.equal(request.params[0].fromBlock, "0x65");
    assert.equal(request.params[0].toBlock, "0x66");
    const topics = [`0x${"00".repeat(32)}`, `0x${payer.slice(2).padStart(64, "0")}`, `0x${hosted.slice(2).padStart(64, "0")}`];
    return json({ result: [
      { data: "0x3e8", topics, blockNumber: "0x66" },
      { data: "0x186a0", topics, blockNumber: "0x66" },
    ] });
  });
  const result = await fromChain(hosted, "base");
  assert.deepEqual(result.payers.get(payer), { calls: 8, usdc: 8000n });
  assert.equal(result.lastAt, "1970-01-01T00:01:40.000Z");
  assert.equal(result.partial, false);
});

test("malformed compatible baselines cannot seed statistics or start an RPC scan", async (t) => {
  const custom = address(8);
  let rpcCalls = 0;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    if (String(input).includes("raw.githubusercontent")) return json({ ...baseline, payTo: custom, payers: { [payer]: { calls: -2, usdcUnits: "1000" } } });
    rpcCalls++;
    return json({ result: "0x64" });
  });
  await assert.rejects(fromChain(custom, "base"), /invalid stats baseline/i);
  assert.equal(rpcCalls, 0);
});

test("a baseline cannot overwrite a payer through differently cased duplicate keys", async (t) => {
  const custom = address(10);
  const lower = address(0xab);
  const upper = `0x${lower.slice(2).toUpperCase()}`;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    if (String(input).includes("raw.githubusercontent")) return json({ ...baseline, payTo: custom, payers: {
      [lower]: { calls: 7, usdcUnits: "7000" }, [upper]: { calls: 1, usdcUnits: "1000" },
    } });
    return json({ result: "0x64" });
  });
  await assert.rejects(fromChain(custom, "base"), /invalid stats baseline/i);
});

test("a baseline cannot report positive transfer counts with too few USDC units", async (t) => {
  const custom = address(11);
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    if (String(input).includes("raw.githubusercontent")) return json({ ...baseline, payTo: custom, payers: {
      [payer]: { calls: 2, usdcUnits: "1" },
    } });
    return json({ result: "0x64" });
  });
  await assert.rejects(fromChain(custom, "base"), /invalid stats baseline/i);
});

test("the first transfer after an empty baseline dates both ends of the history", async (t) => {
  const custom = address(12);
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).includes("raw.githubusercontent")) return json({ ...baseline, payTo: custom, payers: {} });
    const request = JSON.parse(String(init?.body));
    if (request.method === "eth_blockNumber") return json({ result: "0x66" });
    if (request.method === "eth_getBlockByNumber") return json({ result: { timestamp: request.params[0] } });
    const topics = [`0x${"00".repeat(32)}`, `0x${payer.slice(2).padStart(64, "0")}`, `0x${custom.slice(2).padStart(64, "0")}`];
    return json({ result: [
      { data: "0x3e8", topics, blockNumber: "0x66" },
      { data: "0x3e8", topics, blockNumber: "0x65" },
    ] });
  });
  const result = await fromChain(custom, "base");
  assert.equal(result.firstAt, "1970-01-01T00:01:41.000Z");
  assert.equal(result.lastAt, "1970-01-01T00:01:42.000Z");
  assert.equal(result.partial, false);
});

test("a timestamp outage does not claim that successfully counted blocks were unscanned", async (t) => {
  const custom = address(13);
  t.mock.method(console, "warn", () => {});
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).includes("raw.githubusercontent")) return json({ ...baseline, payTo: custom, firstTollAt: "1970-01-01T00:01:00.000Z", lastTollAt: "1970-01-01T00:01:00.000Z" });
    const request = JSON.parse(String(init?.body));
    if (request.method === "eth_blockNumber") return json({ result: "0x65" });
    if (request.method === "eth_getBlockByNumber") return json({ error: { message: "block unavailable" } });
    const topics = [`0x${"00".repeat(32)}`, `0x${payer.slice(2).padStart(64, "0")}`, `0x${custom.slice(2).padStart(64, "0")}`];
    return json({ result: [{ data: "0x3e8", topics, blockNumber: "0x65" }] });
  });
  const result = await fromChain(custom, "base");
  assert.equal(result.payers.get(payer)?.calls, 8);
  assert.equal(result.lastAt, null);
  assert.equal(result.partial, true);
  assert.match(result.note ?? "", /timestamp/i);
  assert.doesNotMatch(result.note ?? "", /not scanned|floor/i);
});

test("an indexer with the right call count but missing revenue falls back to the baseline", async (t) => {
  const custom = address(14);
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("raw.githubusercontent")) return json({ ...baseline, payTo: custom });
    if (url.includes("blockscout")) return json({ items: Array.from({ length: 7 }, () => ({ total: { value: "100" }, from: { hash: payer } })), next_page_params: null });
    const request = JSON.parse(String(init?.body));
    assert.equal(request.method, "eth_blockNumber");
    return json({ result: "0x64" });
  });
  const result = await getStats(custom, "base");
  assert.equal(result.tollsCollected, 7);
  assert.equal(result.revenueUsdc, 0.007);
  assert.match(result.source, /RPC/);
});

test("the chain budget bounds a hung head request before any scan can begin", async (t) => {
  const custom = address(15);
  let started!: () => void;
  const headStarted = new Promise<void>((resolve) => { started = resolve; });
  let headSignal: AbortSignal | undefined;
  let rpcCalls = 0;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(console, "warn", () => {});
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).includes("raw.githubusercontent")) return json({ ...baseline, payTo: custom });
    rpcCalls++;
    headSignal = init?.signal ?? undefined;
    started();
    return new Promise<Response>(() => {}); // An uncooperative upstream ignores abort.
  });
  let settled: Awaited<ReturnType<typeof fromChain>> | undefined;
  void fromChain(custom, "base").then((result) => { settled = result; });
  await headStarted;
  t.mock.timers.tick(9_001);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled?.partial, true);
  assert.equal(settled?.payers.get(payer)?.calls, 7);
  assert.equal(headSignal?.aborted, true);
  assert.equal(rpcCalls, 1);
});

test("a hanging later indexer page cannot spend a new timeout for every page", async (t) => {
  const custom = address(16);
  let started!: () => void;
  const pageStarted = new Promise<void>((resolve) => { started = resolve; });
  let pages = 0;
  let pageSignal: AbortSignal | undefined;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(console, "warn", () => {});
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("raw.githubusercontent")) return json({ ...baseline, payTo: custom });
    if (url.includes("blockscout")) {
      if (++pages === 1) return json({ items: [], next_page_params: { block_number: 100 } });
      pageSignal = init?.signal ?? undefined;
      started();
      return new Promise<Response>(() => {});
    }
    return json({ result: "0x64" });
  });
  let settled: Awaited<ReturnType<typeof getStats>> | undefined;
  void getStats(custom, "base").then((result) => { settled = result; });
  await pageStarted;
  t.mock.timers.tick(8_001);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled?.tollsCollected, 7);
  assert.match(settled?.source ?? "", /RPC/);
  assert.equal(pageSignal?.aborted, true);
  assert.equal(pages, 2);
});

test("a failed parallel lane cannot count later blocks across a missing range", async (t) => {
  const custom = address(17);
  t.mock.method(console, "warn", () => {});
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).includes("raw.githubusercontent")) return json({ ...baseline, payTo: custom });
    const request = JSON.parse(String(init?.body));
    if (request.method === "eth_blockNumber") return json({ result: "0x17d4" }); // 6,100
    const start = Number.parseInt(request.params[0].fromBlock, 16);
    if (start === 2_101) return json({ error: { message: "missing range" } });
    const topics = [`0x${"00".repeat(32)}`, `0x${payer.slice(2).padStart(64, "0")}`, `0x${custom.slice(2).padStart(64, "0")}`];
    return json({ result: [{ data: "0x3e8", topics, blockNumber: `0x${start.toString(16)}` }] });
  });
  const result = await fromChain(custom, "base");
  assert.equal(result.payers.get(payer)?.calls, 7);
  assert.equal(result.partial, true);
  assert.match(result.note ?? "", /Blocks after 100 were not scanned/);
});
