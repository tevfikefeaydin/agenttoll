import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { encodeAbiParameters, encodeEventTopics, parseAbiItem } from "viem";
import { getFreshPools } from "../src/services/fresh.js";

const INITIALIZE = parseAbiItem("event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)");
const MODIFY_LIQUIDITY = parseAbiItem("event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)");
const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as `0x${string}`;
const ZERO = address(0);
const HEAD = 2_000;
const HEAD_TIME = Date.parse("2026-09-30T12:00:00Z");
let clock = Date.now();

function initialize(n: number, block = HEAD, hook = ZERO) {
  return {
    topics: encodeEventTopics({ abi: [INITIALIZE], eventName: "Initialize", args: { id: hash(n), currency0: ZERO, currency1: address(n) } }),
    data: encodeAbiParameters([{ type: "uint24" }, { type: "int24" }, { type: "address" }, { type: "uint160" }, { type: "int24" }], [3_000, 60, hook, 2n ** 96n, 0]),
    blockNumber: `0x${block.toString(16)}`,
    transactionHash: hash(n + 100),
  };
}

function liquidity(n: number, block = HEAD) {
  return {
    topics: encodeEventTopics({ abi: [MODIFY_LIQUIDITY], eventName: "ModifyLiquidity", args: { id: hash(n), sender: address(99) } }),
    data: encodeAbiParameters([{ type: "int24" }, { type: "int24" }, { type: "int256" }, { type: "bytes32" }], [-60, 60, 100n, hash(0)]),
    blockNumber: `0x${block.toString(16)}`,
    transactionHash: hash(n + 200),
  };
}

function mockChain(t: TestContext, created: ReturnType<typeof initialize>[], modified: ReturnType<typeof liquidity>[] = []) {
  clock += 31_000;
  t.mock.method(Date, "now", () => clock);
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body));
    let result: unknown;
    if (request.method === "eth_blockNumber") result = `0x${HEAD.toString(16)}`;
    else if (request.method === "eth_getBlockByNumber") result = { timestamp: `0x${(HEAD_TIME / 1000).toString(16)}` };
    else if (request.method === "eth_getTransactionByHash") result = { from: address(99) };
    else if (request.method === "eth_getLogs") {
      const query = request.params[0];
      // The provider advances to HEAD + 1 after the head was captured. A
      // request for latest would expose both newer pools and newer funding.
      const upper = query.toBlock === "latest" ? HEAD + 1 : Number(BigInt(query.toBlock));
      const logs = query.topics[0] === encodeEventTopics({ abi: [INITIALIZE], eventName: "Initialize" })[0] ? created : modified;
      result = logs.filter(log => Number(BigInt(log.blockNumber)) <= upper);
    } else throw new Error(`Unexpected RPC method: ${request.method}`);
    return Response.json({ jsonrpc: "2.0", id: request.id, result });
  });
}

test("fresh pools and funding remain at the captured head when the chain advances", async (t) => {
  mockChain(t, [initialize(1), initialize(2, HEAD + 1)], [liquidity(1, HEAD + 1)]);
  const result = await getFreshPools("1", "50");
  assert.equal(result.headBlock, HEAD);
  assert.equal(result.pools.length, 1, "A pool from the next block must wait for the next observation");
  assert.equal(result.pools[0].block, HEAD);
  assert.equal(result.pools[0].ageSeconds, 0);
  assert.equal(result.pools[0].createdAt, new Date(HEAD_TIME).toISOString());
  assert.equal(result.pools[0].funded, false, "Next-block liquidity must not leak into this observation");
});

test("bespoke hook counts exclude the zero address and retain unique nonzero hooks", async (t) => {
  await t.test("one pool without a hook", async (sub) => {
    mockChain(sub, [initialize(3)]);
    const result = await getFreshPools("1", "50");
    assert.equal(result.pools[0].hook, ZERO);
    assert.equal(result.pools[0].hookPools, 1);
    assert.equal(result.summary.bespokeHooks, 0);
    assert.match(result.method, /zero hook address means there is no hook/i);
  });
  await t.test("unique and shared hook contracts", async (sub) => {
    const unique = address(50), shared = address(51);
    mockChain(sub, [initialize(4), initialize(5, HEAD, unique), initialize(6, HEAD, shared), initialize(7, HEAD, shared)]);
    const result = await getFreshPools("1", "50");
    assert.equal(result.summary.bespokeHooks, 1);
    assert.equal(result.pools.find(pool => pool.hook === unique)?.hookPools, 1);
    assert.equal(result.pools.find(pool => pool.hook === shared)?.hookPools, 2);
  });
});
