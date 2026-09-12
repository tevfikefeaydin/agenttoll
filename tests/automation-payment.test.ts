import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import { generatePrivateKey } from "viem/accounts";

const root = fileURLToPath(new URL("../", import.meta.url));
const fixture = fs.mkdtempSync(path.join(root, ".automation-tests-"));
const API = "https://agenttoll.app";
const RECIPIENT = "0xe55359021a6a22d8385b827405991c56075f56f8";
const key = generatePrivateKey(); // Disposable, unfunded, and only ever used with mocked HTTP.
const date = new Date().toISOString().slice(0, 10);
const scout = {
  chain: "base", at: `${date}T07:00:00.000Z`, minLiquidityUsd: 15000,
  summary: { found: 0, checked: 0, unchecked: 0, highRisk: 0, caution: 0, insufficientData: 0, clear: 0 },
  pools: [], source: "offline fixture", disclaimer: "Offline regression fixture",
};

before(async () => {
  // Exercise the CLI itself, compiled from current source rather than stale dist.
  // External wallet/HTTP packages stay real; only HTTP is replaced below.
  for (const script of ["keep-warm", "snapshot"]) {
    await build({
      entryPoints: [path.join(root, "scripts", `${script}.mjs`)],
      outfile: path.join(fixture, `${script}.mjs`),
      bundle: true, platform: "node", format: "esm", packages: "external",
      plugins: [{ name: "current-payment-source", setup(builder) {
        builder.onResolve({ filter: /\.\.\/dist\/.+\.js$/ }, args => ({
          path: path.join(root, "src", path.basename(args.path, ".js") + ".ts"),
        }));
      } }],
    });
  }
  fs.writeFileSync(path.join(fixture, "http-fixture.mjs"), `
    import fs from "node:fs";
    const scenario = JSON.parse(fs.readFileSync("scenario.json", "utf8"));
    const calls = [];
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      const signature = request.headers.get("payment-signature") ?? request.headers.get("x-payment");
      calls.push({ url: request.url, signed: Boolean(signature), redirect: init?.redirect ?? request.redirect });
      fs.writeFileSync("calls.json", JSON.stringify(calls));
      if (new URL(request.url).origin !== scenario.origin) throw new Error("Unexpected external HTTP/RPC call blocked by fixture");
      if (scenario.hang) return new Promise(() => {});
      if (!signature) return new Response(null, { status: scenario.redirect ? 302 : 402, headers: {
        "payment-required": Buffer.from(JSON.stringify(scenario.quote)).toString("base64"),
        ...(scenario.redirect ? { location: "https://untrusted.example/api/base/scout" } : {}),
      } });
      return Response.json(scenario.body, { status: scenario.paidStatus ?? 200, headers: {
        "payment-response": Buffer.from(JSON.stringify({ success: true, transaction: "0x" + "a".repeat(64), network: "eip155:8453", payer: "0x" + "b".repeat(40) })).toString("base64"),
      } });
    };
  `);
});

after(() => {
  const resolved = path.resolve(fixture);
  assert.equal(path.dirname(resolved), path.resolve(root));
  assert.ok(path.basename(resolved).startsWith(".automation-tests-"));
  fs.rmSync(resolved, { recursive: true, force: true });
});

type Script = "keep-warm" | "snapshot";
function run(script: Script, options: {
  args?: string[]; env?: Record<string, string>; amount?: string;
  requirement?: Record<string, unknown>; body?: unknown; paidStatus?: number;
  hang?: boolean; redirect?: boolean; existing?: boolean;
} = {}) {
  const cwd = fs.mkdtempSync(path.join(fixture, "run-"));
  const endpoint = script === "keep-warm" ? "/api/price/eth" : "/api/base/scout";
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^(AGENT_|AGENTTOLL_|DOTENV_|WARM_PATH$|NETWORK$|ADDRESS$|FORCE$|NODE_OPTIONS$)/.test(name)) delete env[name];
  }
  Object.assign(env, options.env ?? {});
  const origin = new URL(env.AGENTTOLL_URL ?? API).origin;
  fs.writeFileSync(path.join(cwd, "scenario.json"), JSON.stringify({
    origin, hang: options.hang, redirect: options.redirect, paidStatus: options.paidStatus,
    body: options.body === undefined ? scout : options.body,
    quote: {
      x402Version: 2, resource: { url: origin + endpoint, mimeType: "application/json" },
      accepts: [{ scheme: "exact", network: "eip155:8453",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: RECIPIENT,
        amount: options.amount ?? (script === "keep-warm" ? "1000" : "8000"),
        maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" },
        ...options.requirement,
      }],
    },
  }));
  if (options.existing) {
    fs.mkdirSync(path.join(cwd, "data", "scout"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "data", "scout", `${date}.json`), "already captured\n");
  }
  const result = spawnSync(process.execPath, [
    "--import", pathToFileURL(path.join(fixture, "http-fixture.mjs")).href,
    path.join(fixture, `${script}.mjs`),
    ...(script === "keep-warm" ? ["--path=/api/price/eth"] : []), ...(options.args ?? []),
  ], { cwd, env, encoding: "utf8", timeout: 8000 });
  assert.ifError(result.error);
  const calls: { url: string; signed: boolean; redirect: string }[] = fs.existsSync(path.join(cwd, "calls.json"))
    ? JSON.parse(fs.readFileSync(path.join(cwd, "calls.json"), "utf8")) : [];
  const messages = `${result.stdout}\n${result.stderr}`;
  const json = messages.split(/\r?\n/).flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  return { ...result, calls, messages, json, cwd, data: path.join(cwd, "data", "scout") };
}

for (const script of ["keep-warm", "snapshot"] as const) {
  test(`${script}: dry-run resolves the request without a key, HTTP, signing, or data writes`, () => {
    const result = run(script, { args: ["--dry-run"] });
    assert.equal(result.status, 0, result.messages);
    assert.deepEqual(result.calls, []);
    assert.equal(fs.existsSync(result.data), false);
    assert.equal(result.json.at(-1)?.mode, "dry-run");
    assert.equal(result.json.at(-1)?.budget?.canSign, false);
    assert.equal(result.json.at(-1)?.budget?.totalUsdc, script === "keep-warm" ? "0.001000" : "0.008000");
  });

  test(`${script}: dry-run ignores even an invalid private key`, () => {
    const result = run(script, { args: ["--dry-run"], env: { AGENT_PRIVATE_KEY: "not-a-key" } });
    assert.equal(result.status, 0, result.messages);
    assert.deepEqual(result.calls, []);
  });

  test(`${script}: quote-only validates one unsigned quote and never creates a snapshot`, () => {
    const result = run(script, { args: ["--quote-only"] });
    assert.equal(result.status, 0, result.messages);
    assert.equal(result.calls.length, 1);
    assert.equal(result.calls[0].signed, false);
    assert.equal(result.calls[0].redirect, "manual");
    assert.equal(fs.existsSync(result.data), false);
    assert.equal(result.json.at(-1)?.budget?.canSign, false);
    assert.equal(result.json.at(-1)?.budget?.reservedUsdc, "0.000000");
  });

  test(`${script}: unknown options fail before an authenticated request`, () => {
    const result = run(script, { args: ["--dry-rnu"], env: { AGENT_PRIVATE_KEY: key } });
    assert.equal(result.status, 1, result.messages);
    assert.deepEqual(result.calls, []);
    assert.match(result.messages, /unknown|unsupported.*option/i);
  });

  test(`${script}: missing keys and invalid configuration fail before HTTP`, () => {
    const configurations: Record<string, string>[] = [
      {},
      { AGENT_PRIVATE_KEY: "not-a-key" },
      { AGENT_PRIVATE_KEY: key, AGENTTOLL_URL: "https://agenttoll.app/unexpected-path" },
      { AGENT_PRIVATE_KEY: key, AGENTTOLL_NETWORK: "unknown-chain" },
      { AGENT_PRIVATE_KEY: key, AGENTTOLL_TIMEOUT_MS: "NaN" },
      { AGENT_PRIVATE_KEY: key, AGENTTOLL_BUDGET_USDC: "-1" },
      { AGENT_PRIVATE_KEY: key, AGENTTOLL_MODE: "dry-rnu" },
    ];
    for (const env of configurations) {
      const result = run(script, { env });
      assert.equal(result.status, 1, result.messages);
      assert.deepEqual(result.calls, []);
      assert.equal(fs.existsSync(result.data), false);
    }
  });

  test(`${script}: conflicting preview flags fail without paying`, () => {
    const result = run(script, { args: ["--dry-run", "--quote-only"], env: { AGENT_PRIVATE_KEY: key } });
    assert.equal(result.status, 1, result.messages);
    assert.deepEqual(result.calls, []);
  });

  test(`${script}: workflow preview mode never pays even with a key available`, () => {
    const result = run(script, { env: { AGENTTOLL_MODE: "quote-only", AGENT_PRIVATE_KEY: key } });
    assert.equal(result.status, 0, result.messages);
    assert.equal(result.calls.length, 1);
    assert.equal(result.calls[0].signed, false);
    assert.equal(result.json.at(-1)?.budget?.canSign, false);
    assert.equal(fs.existsSync(result.data), false);
  });

  test(`${script}: a custom host without explicit recipient is rejected before HTTP`, () => {
    const result = run(script, { env: { AGENT_PRIVATE_KEY: key, AGENTTOLL_URL: "https://custom.example" } });
    assert.equal(result.status, 1, result.messages);
    assert.deepEqual(result.calls, []);
    assert.match(result.messages, /recipient/i);
  });

  test(`${script}: a 50 USDC quote is rejected without a signed retry`, () => {
    const result = run(script, { env: { AGENT_PRIVATE_KEY: key }, amount: "50000000" });
    assert.equal(result.status, 1, result.messages);
    assert.equal(result.calls.length, 1);
    assert.equal(result.calls.some(call => call.signed), false);
    assert.match(result.messages, /ceiling|price/i);
  });

  test(`${script}: an untrusted recipient is rejected without a signed retry`, () => {
    const result = run(script, { env: { AGENT_PRIVATE_KEY: key }, requirement: { payTo: "0x" + "1".repeat(40) } });
    assert.equal(result.status, 1, result.messages);
    assert.equal(result.calls.length, 1);
    assert.equal(result.calls.some(call => call.signed), false);
    assert.match(result.messages, /recipient/i);
  });

  test(`${script}: a lower configured budget blocks signing`, () => {
    const result = run(script, { env: { AGENT_PRIVATE_KEY: key, AGENTTOLL_BUDGET_USDC: "0" } });
    assert.equal(result.status, 1, result.messages);
    assert.equal(result.calls.length, 1);
    assert.equal(result.calls.some(call => call.signed), false);
    assert.match(result.messages, /budget/i);
  });

  test(`${script}: quote timeout ends the CLI without a signed retry`, () => {
    const result = run(script, { env: { AGENT_PRIVATE_KEY: key, AGENTTOLL_TIMEOUT_MS: "25" }, hang: true });
    assert.equal(result.status, 1, result.messages);
    assert.equal(result.calls.length, 1);
    assert.equal(result.calls.some(call => call.signed), false);
    assert.match(result.messages, /timed out/i);
    assert.equal(result.json.at(-1)?.budget?.reservedUsdc, "0.000000");
  });

  test(`${script}: a redirect cannot move a signing request to another origin`, () => {
    const result = run(script, { env: { AGENT_PRIVATE_KEY: key }, redirect: true });
    assert.equal(result.status, 1, result.messages);
    assert.equal(result.calls.length, 1);
    assert.equal(result.calls[0].signed, false);
    assert.equal(result.calls[0].redirect, "manual");
  });

  test(`${script}: HTTP failure after signing reports the reserved amount`, () => {
    const result = run(script, { env: { AGENT_PRIVATE_KEY: key }, paidStatus: 500 });
    assert.equal(result.status, 1, result.messages);
    assert.equal(result.calls.filter(call => call.signed).length, 1);
    assert.equal(result.json.at(-1)?.budget?.reservedUsdc, script === "keep-warm" ? "0.001000" : "0.008000");
    assert.equal(result.json.at(-1)?.budget?.spentUsdc, "0.000000");
    assert.equal(fs.existsSync(result.data), false);
  });

  test(`${script}: a normal fixture pays exactly once within the one-call budget`, () => {
    const result = run(script, { env: { AGENT_PRIVATE_KEY: key } });
    assert.equal(result.status, 0, result.messages);
    assert.equal(result.calls.length, 2);
    assert.equal(result.calls.filter(call => call.signed).length, 1);
    assert.equal(result.json.at(-1)?.budget?.spentUsdc, script === "keep-warm" ? "0.001000" : "0.008000");
    assert.equal(result.json.at(-1)?.budget?.remainingUsdc, "0.000000");
    if (script === "snapshot") {
      const snapshot = JSON.parse(fs.readFileSync(path.join(result.data, `${date}.json`), "utf8"));
      assert.deepEqual(snapshot.pools, []);
      assert.equal(snapshot.settlement, "0x" + "a".repeat(64));
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(result.data, "index.json"), "utf8")).dates, [date]);
    }
  });
}

test("snapshot: malformed successful scout output cannot create a poisoned snapshot or index", () => {
  const result = run("snapshot", { env: { AGENT_PRIVATE_KEY: key }, body: { at: `${date}T07:00:00.000Z`, pools: [] } });
  assert.equal(result.status, 1, result.messages);
  assert.equal(fs.existsSync(result.data), false);
  assert.match(result.messages, /invalid.*scout|scout.*invalid/i);
});

test("snapshot: malformed pool data cannot replace an existing snapshot", () => {
  const result = run("snapshot", {
    existing: true, env: { AGENT_PRIVATE_KEY: key, FORCE: "1" },
    body: { ...scout, pools: [{}], summary: { ...scout.summary, found: 1, unchecked: 1 } },
  });
  assert.equal(result.status, 1, result.messages);
  assert.equal(fs.readFileSync(path.join(result.data, `${date}.json`), "utf8"), "already captured\n");
  assert.equal(fs.existsSync(path.join(result.data, "index.json")), false);
});

test("snapshot: a complete nonempty scout fixture preserves pool observations", () => {
  const pool = {
    name: "Fixture / ETH", pool: "0x" + "c".repeat(64), token: "0x" + "d".repeat(40),
    createdAt: `${date}T06:00:00.000Z`, priceUsd: 0.1, liquidityUsd: 18000, volume24hUsd: 2500,
    safety: { verdict: "caution", failed: [], warnings: ["deployer"], unchecked: ["liquidity"] },
  };
  const result = run("snapshot", { env: { AGENT_PRIVATE_KEY: key }, body: {
    ...scout, pools: [pool], summary: { ...scout.summary, found: 1, checked: 1, caution: 1 },
  } });
  assert.equal(result.status, 0, result.messages);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(result.data, `${date}.json`), "utf8")).pools, [pool]);
});

test("keep-warm: an unknown catalogue path is rejected before HTTP", () => {
  const result = run("keep-warm", { env: { AGENT_PRIVATE_KEY: key, WARM_PATH: "/api/not-registered" } });
  assert.equal(result.status, 1, result.messages);
  assert.deepEqual(result.calls, []);
});

test("snapshot: an existing snapshot is skipped without a wallet or HTTP", () => {
  const result = run("snapshot", { existing: true });
  assert.equal(result.status, 0, result.messages);
  assert.deepEqual(result.calls, []);
  assert.equal(fs.readFileSync(path.join(result.data, `${date}.json`), "utf8"), "already captured\n");
});
