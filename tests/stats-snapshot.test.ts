import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { test, type TestContext } from "node:test";

const payTo = "0x0000000000000000000000000000000000000001";
const payer = "0x0000000000000000000000000000000000000063";
const hash = `0x${"a".repeat(64)}`;
const previous = {
  network: "base", payTo, block: 100,
  at: "1970-01-01T00:02:00.000Z",
  firstTollAt: "1970-01-01T00:01:30.000Z", lastTollAt: "1970-01-01T00:01:40.000Z",
  payers: { [payer]: { calls: 7, usdcUnits: "7000" } },
  schemaVersion: 1, fromBlock: 100, blockHash: hash,
  countingPolicy: "usdc-transfer-1-50000-v1",
};

/** Run the real CLI and filesystem path, replacing only the public network. */
function runSnapshot(t: TestContext, initial: unknown, options: {
  fullRebuild?: boolean; mismatch?: boolean; changedTarget?: boolean;
  failLogs?: boolean; fromBlock?: string;
} = {}) {
  const root = process.cwd();
  const directory = fs.mkdtempSync(path.join(root, "tests", ".stats-snapshot-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const outputPath = path.join(directory, "data", "stats.json");
  const input = `${JSON.stringify(initial, null, 2)}\n`;
  fs.mkdirSync(path.dirname(outputPath));
  fs.writeFileSync(outputPath, input);
  const requestsPath = path.join(directory, "requests.json");
  const script = pathToFileURL(path.join(root, "scripts", "stats-snapshot.mjs")).href;
  const harness = `
    import fs from "node:fs";
    const options = ${JSON.stringify(options)};
    const requests = [];
    let targetReads = 0;
    globalThis.fetch = async (_input, init) => {
      const request = JSON.parse(init.body);
      requests.push(request);
      fs.writeFileSync(${JSON.stringify(requestsPath)}, JSON.stringify(requests));
      let result;
      if (request.method === "eth_blockNumber") result = "0x67";
      else if (request.method === "eth_getBlockByNumber") {
        const block = request.params[0] === "finalized" ? 102 : parseInt(request.params[0], 16);
        if (block === 102) targetReads++;
        const changed = (options.mismatch && block === 100) || (options.changedTarget && block === 102 && targetReads > 1);
        result = { number: "0x" + block.toString(16), timestamp: "0x" + block.toString(16), hash: "0x" + (changed ? "b" : "a").repeat(64) };
      } else if (request.method === "eth_getLogs") {
        if (options.failLogs) return Response.json({ error: { message: "RPC log outage" } });
        const query = request.params[0];
        const start = parseInt(query.fromBlock, 16), end = parseInt(query.toBlock, 16);
        result = [100, 102].filter(block => block >= start && block <= end).map(block => ({
          address: query.address,
          data: "0x" + (1000).toString(16).padStart(64, "0"),
          topics: [query.topics[0], "0x" + ${JSON.stringify(payer.slice(2))}.padStart(64, "0"), query.topics[2]],
          blockNumber: "0x" + block.toString(16), blockHash: ${JSON.stringify(hash)},
          logIndex: "0x0", transactionHash: "0x" + block.toString(16).padStart(64, "0"), removed: false,
        }));
      } else throw new Error("Unexpected RPC method: " + request.method);
      return Response.json({ jsonrpc: "2.0", id: request.id, result });
    };
    process.argv = [process.execPath, ${JSON.stringify(script)}, ...(options.fullRebuild ? ["--full-rebuild"] : [])];
    await import(${JSON.stringify(script)});
  `;
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", harness], {
    cwd: directory, env: { ...process.env, ADDRESS: payTo, STATS_FROM_BLOCK: options.fromBlock ?? "100" },
    encoding: "utf8", timeout: 15_000,
  });
  assert.ifError(child.error);
  const content = fs.readFileSync(outputPath, "utf8");
  return {
    status: child.status, stderr: child.stderr, stdout: child.stdout,
    input, content, snapshot: JSON.parse(content),
    requests: fs.existsSync(requestsPath) ? JSON.parse(fs.readFileSync(requestsPath, "utf8")) as { method: string; params: any[] }[] : [],
    outputFiles: fs.readdirSync(path.dirname(outputPath)),
  };
}

test("daily snapshots extend a verified checkpoint without rereading counted blocks", (t) => {
  const run = runSnapshot(t, previous);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.snapshot.payers[payer], { calls: 8, usdcUnits: "8000" });
  assert.equal(run.snapshot.block, 102); // The finalized block, not latest=103.
  assert.equal(run.snapshot.blockHash, hash);
  assert.equal(run.snapshot.firstTollAt, previous.firstTollAt);
  assert.equal(run.snapshot.lastTollAt, "1970-01-01T00:01:42.000Z");
  assert.deepEqual(run.requests.filter(r => r.method === "eth_getLogs").map(r => r.params[0]), [{
    fromBlock: "0x65", toBlock: "0x66", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", null, `0x${payTo.slice(2).padStart(64, "0")}`],
  }]);
  assert.deepEqual(run.outputFiles, ["stats.json"]);
});

test("a legacy snapshot is rebuilt once automatically before it can be resumed", (t) => {
  const { schemaVersion, fromBlock, blockHash, countingPolicy, ...legacy } = previous;
  const run = runSnapshot(t, legacy);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.snapshot.payers[payer], { calls: 2, usdcUnits: "2000" });
  assert.equal(run.snapshot.schemaVersion, 1);
  assert.equal(run.snapshot.fromBlock, 100);
  assert.equal(run.snapshot.countingPolicy, "usdc-transfer-1-50000-v1");
  assert.match(run.stdout, /legacy.*rebuild|rebuild.*legacy/i);
});

test("a changed checkpoint hash preserves the old file and demands an explicit rebuild", (t) => {
  const run = runSnapshot(t, previous, { mismatch: true });
  assert.notEqual(run.status, 0);
  assert.equal(run.content, run.input);
  assert.match(run.stderr, /checkpoint.*hash|hash.*checkpoint/i);
  assert.match(run.stderr, /--full-rebuild/);
  assert.equal(run.requests.filter(r => r.method === "eth_getLogs").length, 0);
});

test("a chain change during a scan cannot publish a new checkpoint", (t) => {
  const run = runSnapshot(t, previous, { changedTarget: true });
  assert.notEqual(run.status, 0);
  assert.equal(run.content, run.input);
  assert.match(run.stderr, /changed|hash/i);
  assert.deepEqual(run.outputFiles, ["stats.json"]);
});

test("an explicit full rebuild replaces checkpoint totals from the configured start", (t) => {
  const run = runSnapshot(t, previous, { fullRebuild: true, mismatch: true });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.snapshot.payers[payer], { calls: 2, usdcUnits: "2000" });
  assert.equal(run.snapshot.block, 102);
  assert.equal(run.requests.find(r => r.method === "eth_getLogs")?.params[0].fromBlock, "0x64");
});

test("invalid scan bounds fail before network access and preserve the snapshot", (t) => {
  const run = runSnapshot(t, previous, { fromBlock: "NaN" });
  assert.notEqual(run.status, 0);
  assert.equal(run.content, run.input);
  assert.equal(run.requests.length, 0);
});

test("malformed checkpoint counts cannot be promoted into a new snapshot", (t) => {
  const run = runSnapshot(t, { ...previous, payers: { [payer]: { calls: 2, usdcUnits: "1" } } });
  assert.notEqual(run.status, 0);
  assert.equal(run.content, run.input);
  assert.equal(run.requests.filter(r => r.method === "eth_getLogs").length, 0);
});

test("a persistent log outage leaves the old snapshot intact after bounded retries", (t) => {
  const run = runSnapshot(t, previous, { failLogs: true });
  assert.notEqual(run.status, 0);
  assert.equal(run.content, run.input);
  assert.equal(run.requests.filter(r => r.method === "eth_getLogs").length, 8); // 4 attempts, 2 providers.
  assert.deepEqual(run.outputFiles, ["stats.json"]);
});
