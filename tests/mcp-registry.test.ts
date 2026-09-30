import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const moduleUrl = new URL("../scripts/mcp-registry-publish.mjs", import.meta.url).href;
const { publishRegistry } = await import(moduleUrl);
const server = JSON.parse(readFileSync(new URL("../mcp/server.json", import.meta.url), "utf8"));
const pkg = JSON.parse(readFileSync(new URL("../mcp/package.json", import.meta.url), "utf8"));
const registry = "https://registry.modelcontextprotocol.io";
const exactUrl = `${registry}/v0.1/servers/${encodeURIComponent(server.name)}/versions/${pkg.version}`;
const tokenUrl = "https://pipelines.actions.githubusercontent.com/test/oidctoken?api-version=2.0";
const integrity = "sha512-" + "A".repeat(86) + "==";
const evidence = { package: pkg.name, version: pkg.version, source: "public-npm", integrity,
  consumer: { version: pkg.version, cases: ["keyless", "zero-budget", "recipient", "overcharge", "timeout", "cancellation", "normal"].map(mode => ({ mode, version: pkg.version, tools: 23, signedRetries: mode === "normal" ? 1 : 0 })) } };
const context = () => ({ server: structuredClone(server), pkg: structuredClone(pkg), tag: `mcp-v${pkg.version}`,
  repository: "tevfikefeaydin/agenttoll", verification: structuredClone(evidence), tarballIntegrity: integrity,
  env: { GITHUB_ACTIONS: "true", ACTIONS_ID_TOKEN_REQUEST_URL: tokenUrl, ACTIONS_ID_TOKEN_REQUEST_TOKEN: "synthetic-request-token" } });
const record = () => ({ server: structuredClone(server), _meta: { "io.modelcontextprotocol.registry/official": { status: "active", isLatest: true } } });
const npmMetadata = () => ({ ...structuredClone(pkg), dist: { integrity } });

test("registry publication uses OIDC only after npm verification and verifies the exact public record", async () => {
  const requests: Array<{ url: string; method: string }> = [];
  let exactReads = 0;
  const result = await publishRegistry(context(), async (url: string, init: RequestInit = {}) => {
    requests.push({ url, method: init.method ?? "GET" });
    assert.equal(init.redirect, "error");
    assert.ok(init.signal);
    if (url.startsWith("https://registry.npmjs.org/")) return Response.json(npmMetadata());
    if (url === exactUrl) return ++exactReads === 1 ? new Response(null, { status: 404 }) : Response.json(record());
    if (url.startsWith(tokenUrl)) {
      assert.equal(new URL(url).searchParams.get("audience"), registry);
      assert.equal(new Headers(init.headers).get("authorization"), "Bearer synthetic-request-token");
      return Response.json({ value: "synthetic-oidc-token" });
    }
    if (url === `${registry}/v0.1/auth/github-oidc`) {
      assert.deepEqual(JSON.parse(String(init.body)), { oidc_token: "synthetic-oidc-token" });
      return Response.json({ registry_token: "synthetic-registry-token", expires_at: Date.now() / 1000 + 300 });
    }
    assert.equal(url, `${registry}/v0.1/publish`);
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer synthetic-registry-token");
    assert.deepEqual(JSON.parse(String(init.body)), server);
    return Response.json(record());
  });
  assert.equal(result.action, "published");
  assert.equal(result.url, exactUrl);
  assert.equal(requests.length, 6);
  assert.deepEqual(requests.map(request => request.method), ["GET", "GET", "GET", "POST", "POST", "GET"]);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-(?:request|oidc|registry)-token/);
});

test("registry-only retry accepts an identical active record without requesting credentials or writing", async () => {
  const args = context();
  args.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = "";
  const methods: string[] = [];
  const result = await publishRegistry(args, async (url: string, init: RequestInit) => {
    methods.push(init.method ?? "GET");
    return Response.json(url === exactUrl ? record() : npmMetadata());
  });
  assert.equal(result.action, "already-published");
  assert.deepEqual(methods, ["GET", "GET"]);
});

test("exact Registry verification accepts only the official omission of false environment flags", async () => {
  const remote = record();
  for (const variable of remote.server.packages[0].environmentVariables) {
    if (variable.isRequired === false) delete variable.isRequired;
    if (variable.isSecret === false) delete variable.isSecret;
  }
  const result = await publishRegistry(context(), async (url: string) => Response.json(url === exactUrl ? remote : npmMetadata()));
  assert.equal(result.action, "already-published");
  remote.server.packages[0].environmentVariables[0].isSecret = false;
  await assert.rejects(publishRegistry(context(), async (url: string) => Response.json(url === exactUrl ? remote : npmMetadata())), /differs/);
});

for (const [label, mutate] of [
  ["tag", (args: any) => { args.tag = "refs/heads/main"; }],
  ["local invocation", (args: any) => { args.env.GITHUB_ACTIONS = "false"; }],
  ["namespace", (args: any) => { args.server.name = "io.github.other/agenttoll"; }],
  ["repository", (args: any) => { args.repository = "other/agenttoll"; }],
  ["package repository", (args: any) => { args.pkg.repository.url = "https://github.com/other/agenttoll"; }],
  ["unverified npm bytes", (args: any) => { args.tarballIntegrity = "sha512-changed"; }],
  ["local-only evidence", (args: any) => { args.verification.source = "local-tarball"; }],
  ["failed policy evidence", (args: any) => { args.verification.consumer.cases[1].signedRetries = 1; }],
] as const) {
  test(`registry publication rejects ${label} before HTTP`, async () => {
    const args = context();
    mutate(args);
    let calls = 0;
    await assert.rejects(publishRegistry(args, async () => { calls++; assert.fail("Invalid release reached HTTP"); }));
    assert.equal(calls, 0);
  });
}

for (const field of ["version", "mcpName", "integrity", "repository"] as const) {
  test(`registry publication rejects mismatched npm ${field} before OIDC`, async () => {
    let calls = 0;
    const remote = npmMetadata();
    if (field === "integrity") remote.dist.integrity = "changed";
    else if (field === "repository") remote.repository.url = "https://github.com/other/agenttoll";
    else remote[field] = "changed";
    await assert.rejects(publishRegistry(context(), async () => { calls++; return Response.json(remote); }), /npm/i);
    assert.equal(calls, 1);
  });
}

for (const changed of ["description", "status"] as const) {
  test(`an existing registry record with different ${changed} is never overwritten`, async () => {
    let calls = 0;
    const remote = record();
    if (changed === "description") remote.server.description = "Unexpected content";
    else remote._meta["io.modelcontextprotocol.registry/official"].status = "deprecated";
    await assert.rejects(publishRegistry(context(), async () => Response.json(++calls === 1 ? npmMetadata() : remote)), /registry/i);
    assert.equal(calls, 2);
  });
}

test("OIDC failure reports a bounded status without response bodies or another publication attempt", async () => {
  let calls = 0;
  await assert.rejects(publishRegistry(context(), async () => {
    calls++;
    if (calls === 1) return Response.json(npmMetadata());
    if (calls === 2) return new Response(null, { status: 404 });
    return new Response("SECRET-token-echo", { status: 403 });
  }), (error: Error) => {
    assert.match(error.message, /OIDC.*403/);
    assert.doesNotMatch(error.message, /SECRET/);
    return true;
  });
  assert.equal(calls, 3);
});

test("publication failure is not automatically retried and cannot leak response tokens", async () => {
  let calls = 0;
  await assert.rejects(publishRegistry(context(), async () => {
    calls++;
    if (calls === 1) return Response.json(npmMetadata());
    if (calls === 2) return new Response(null, { status: 404 });
    if (calls === 3) return Response.json({ value: "synthetic-oidc-token" });
    if (calls === 4) return Response.json({ registry_token: "synthetic-registry-token" });
    return new Response("SECRET-token-echo", { status: 500 });
  }), (error: Error) => {
    assert.match(error.message, /publish.*500/);
    assert.doesNotMatch(error.message, /SECRET/);
    return true;
  });
  assert.equal(calls, 5);
});

test("successful publish response is insufficient when the public record differs", async () => {
  let calls = 0;
  await assert.rejects(publishRegistry(context(), async () => {
    calls++;
    if (calls === 1) return Response.json(npmMetadata());
    if (calls === 2) return new Response(null, { status: 404 });
    if (calls === 3) return Response.json({ value: "synthetic-oidc-token" });
    if (calls === 4) return Response.json({ registry_token: "synthetic-registry-token" });
    const remote = record();
    if (calls === 6) remote.server.packages[0].version = "0.0.1";
    return Response.json(remote);
  }), /registry/i);
  assert.equal(calls, 6);
});

test("Registry visibility retry repeats only the read, with one publication", async () => {
  let calls = 0;
  let waits = 0;
  const result = await publishRegistry(context(), async () => {
    calls++;
    if (calls === 1) return Response.json(npmMetadata());
    if (calls === 2 || calls === 6) return new Response(null, { status: 404 });
    if (calls === 3) return Response.json({ value: "synthetic-oidc-token" });
    if (calls === 4) return Response.json({ registry_token: "synthetic-registry-token" });
    return Response.json(record());
  }, async (ms: number) => { assert.equal(ms, 2000); waits++; });
  assert.equal(result.action, "published");
  assert.equal(calls, 7);
  assert.equal(waits, 1);
});

test("OIDC request credentials cannot be redirected to a different host", async () => {
  const args = context();
  args.env.ACTIONS_ID_TOKEN_REQUEST_URL = "https://attacker.invalid/oidc";
  let calls = 0;
  await assert.rejects(publishRegistry(args, async () => ++calls === 1 ? Response.json(npmMetadata()) : new Response(null, { status: 404 })), /OIDC endpoint/);
  assert.equal(calls, 2);
});
