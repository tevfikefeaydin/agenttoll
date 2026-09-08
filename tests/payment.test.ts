import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { toClientEvmSigner } from "@x402/evm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { payingFetch } from "../src/pay.js";
import { createPaymentClient } from "../src/payment-policy.js";
import { createAgentTollServer } from "../mcp/server.js";
import { MCP_VERSION } from "../mcp/version.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const API = "https://agenttoll.app";
const RECIPIENT = "0xe55359021a6a22d8385b827405991c56075f56f8";
const ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

function quote(amount = "1000", overrides: Record<string, unknown> = {}) {
  return {
    x402Version: 2,
    resource: { url: `${API}/api/price/eth`, mimeType: "application/json" },
    accepts: [{
      scheme: "exact", network: "eip155:84532", amount, asset: ASSET,
      payTo: RECIPIENT, maxTimeoutSeconds: 60, extra: { name: "USDC", version: "2" },
      ...overrides,
    }],
  };
}

function paymentRequired(value = quote()) {
  return new Response(null, {
    status: 402,
    headers: { "payment-required": Buffer.from(JSON.stringify(value)).toString("base64") },
  });
}

function mockApi(value = quote()) {
  const signed: Record<string, any>[] = [];
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    assert.equal(new URL(request.url).origin, API, "Unexpected external HTTP/RPC call");
    const header = request.headers.get("payment-signature");
    if (!header) return paymentRequired(value);
    signed.push(JSON.parse(Buffer.from(header, "base64").toString()));
    return Response.json({ symbol: "eth", usd: 2000 });
  };
  return signed;
}

test("an excessive 50 USDC quote never produces a signed retry", async () => {
  const signed = mockApi(quote("50000000"));
  const client = payingFetch(generatePrivateKey(), "base-sepolia");
  await assert.rejects(client.fetchWithPayment(`${API}/api/price/eth`), /ceiling|price|amount/i);
  assert.equal(signed.length, 0);
});

test("concurrent quotes cannot spend the same remaining session budget", async () => {
  const signed = mockApi();
  const client = payingFetch(generatePrivateKey(), "base-sepolia", { totalBudgetUsdc: "0.001" });
  const results = await Promise.allSettled([
    client.fetchWithPayment(`${API}/api/price/eth`),
    client.fetchWithPayment(`${API}/api/price/eth`),
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.filter(result => result.status === "rejected").length, 1);
  assert.equal(signed.length, 1);
  assert.equal(client.getPaymentBudget().remainingUsdc, "0.000000");
});

test("a normal quote signs the exact amount, recipient and chain and spends only that amount", async () => {
  const signed = mockApi();
  const client = payingFetch(generatePrivateKey(), "base-sepolia");
  assert.deepEqual(await (await client.fetchWithPayment(`${API}/api/price/eth`)).json(), { symbol: "eth", usd: 2000 });
  assert.equal(signed.length, 1);
  assert.equal(signed[0].accepted.network, "eip155:84532");
  assert.equal(signed[0].payload.authorization.to.toLowerCase(), RECIPIENT);
  assert.equal(signed[0].payload.authorization.value, "1000");
  assert.match(signed[0].payload.signature, /^0x[0-9a-f]{130}$/i);
  assert.equal(client.getPaymentBudget().remainingUsdc, "0.999000");
  assert.equal(client.getPaymentBudget().spentUsdc, "0.001000");
  assert.equal(client.getPaymentBudget().reservedUsdc, "0.000000");
});

for (const [name, changes, reason] of [
  ["wrong network", { network: "eip155:8453" }, /network/i],
  ["wrong recipient", { payTo: "0x0000000000000000000000000000000000000001" }, /recipient/i],
  ["wrong asset", { asset: "0x0000000000000000000000000000000000000001" }, /asset|USDC/i],
  ["non-integer amount", { amount: "1e3" }, /amount/i],
  ["unbounded lifetime", { maxTimeoutSeconds: 86400 }, /lifetime/i],
  ["approval transfer method", { extra: { name: "USDC", version: "2", assetTransferMethod: "permit2" } }, /transfer method/i],
] as const) {
  test(`${name} never reaches the signing boundary`, async () => {
    mockApi(quote("1000", changes));
    const account = privateKeyToAccount(generatePrivateKey());
    let signingAttempts = 0;
    const signer = toClientEvmSigner({ address: account.address, signTypedData: async data => {
      signingAttempts++;
      return account.signTypedData(data as Parameters<typeof account.signTypedData>[0]);
    } });
    const client = createPaymentClient("base-sepolia", signer);
    await assert.rejects(client.fetchWithPayment(`${API}/api/price/eth`), reason);
    assert.equal(signingAttempts, 0);
    assert.equal(client.getPaymentBudget().remainingUsdc, "1.000000");
  });
}

test("a caller may lower but cannot raise a registered endpoint ceiling", async () => {
  mockApi(quote("2000"));
  const client = payingFetch(generatePrivateKey(), "base-sepolia", { maxPerCallUsdc: "100", totalBudgetUsdc: "100" });
  await assert.rejects(client.fetchWithPayment(`${API}/api/price/eth`), /ceiling/i);
  mockApi();
  const lower = payingFetch(generatePrivateKey(), "base-sepolia", { maxPerCallUsdc: "0.0009" });
  await assert.rejects(lower.fetchWithPayment(`${API}/api/price/eth`), /ceiling/i);
});

test("invalid budgets and networks fail before network access", () => {
  globalThis.fetch = async () => { assert.fail("Invalid configuration accessed the network"); };
  for (const totalBudgetUsdc of [Infinity, NaN, "-1", "0.0000001", "1e100"]) {
    assert.throws(() => payingFetch(generatePrivateKey(), "base-sepolia", { totalBudgetUsdc }), /budget/i);
  }
  assert.throws(() => payingFetch(generatePrivateKey(), "typo"), /network/i);
  assert.throws(() => payingFetch(generatePrivateKey(), "base", { timeoutMs: Infinity }), /timeout/i);
});

test("a custom API origin requires an explicit trusted recipient", () => {
  assert.throws(() => createPaymentClient("base-sepolia", undefined, { baseUrl: "http://localhost:3000" }), /recipient/i);
  const client = createPaymentClient("base-sepolia", undefined, { baseUrl: "http://localhost:3000", recipient: RECIPIENT });
  assert.equal(client.getPaymentBudget().apiOrigin, "http://localhost:3000");
});

test("unregistered endpoints and other origins are rejected before making a request", async () => {
  globalThis.fetch = async () => { assert.fail("An untrusted endpoint was fetched"); };
  const client = payingFetch(generatePrivateKey(), "base-sepolia");
  await assert.rejects(client.fetchWithPayment("https://attacker.example/api/price/eth"), /origin/i);
  await assert.rejects(client.fetchWithPayment(`${API}/api/unregistered`), /registered/i);
  await assert.rejects(client.fetchWithPayment(`${API}/api/price/a%2Fb`), /path/i);
});

test("a redirect to another origin is never followed or signed", async () => {
  let requests = 0;
  globalThis.fetch = async (input, init) => {
    requests++;
    const request = new Request(input, init);
    assert.equal(request.redirect, "manual");
    return new Response(null, { status: 307, headers: { location: "https://attacker.example/api/price/eth" } });
  };
  const client = payingFetch(generatePrivateKey(), "base-sepolia");
  await assert.rejects(client.fetchWithPayment(`${API}/api/price/eth`), /redirect/i);
  assert.equal(requests, 1);
  assert.equal(client.getPaymentBudget().reservedUsdc, "0.000000");
});

test("a signed request timeout aborts HTTP and retains its ambiguous reservation", async () => {
  let signedRequests = 0;
  let aborted = false;
  const activeRequests: Request[] = [];
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (!request.headers.has("payment-signature")) return paymentRequired();
    signedRequests++;
    activeRequests.push(request);
    return new Promise<Response>((_resolve, reject) => {
      request.signal.addEventListener("abort", () => { aborted = true; reject(request.signal.reason); }, { once: true });
    });
  };
  const client = payingFetch(generatePrivateKey(), "base-sepolia", { timeoutMs: 250, totalBudgetUsdc: "0.001" });
  await assert.rejects(client.fetchWithPayment(`${API}/api/price/eth`), /timed out/i);
  assert.equal(aborted, true);
  assert.equal(activeRequests[0].signal.aborted, true);
  assert.equal(client.getPaymentBudget().reservedUsdc, "0.001000");
  assert.equal(client.getPaymentBudget().remainingUsdc, "0.000000");
  await assert.rejects(client.fetchWithPayment(`${API}/api/price/eth`), /budget/i);
  assert.equal(signedRequests, 1);
});

test("the total deadline also bounds an unfinished paid response body", async () => {
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (!request.headers.has("payment-signature")) return paymentRequired();
    return new Response(new ReadableStream({ start() { /* external body never completes */ } }));
  };
  const client = payingFetch(generatePrivateKey(), "base-sepolia", { timeoutMs: 250 });
  await assert.rejects(client.fetchWithPayment(`${API}/api/price/eth`), /timed out/i);
  assert.equal(client.getPaymentBudget().reservedUsdc, "0.001000");
});

test("an abort before signing does not reserve any budget", async () => {
  globalThis.fetch = async () => { assert.fail("A pre-aborted call reached HTTP"); };
  const abort = new AbortController();
  abort.abort(new Error("User stopped this call"));
  const client = payingFetch(generatePrivateKey(), "base-sepolia");
  await assert.rejects(client.fetchWithPayment(`${API}/api/price/eth`, { signal: abort.signal }), /User stopped/);
  assert.equal(client.getPaymentBudget().remainingUsdc, "1.000000");
});

test("a rejected signature releases its reservation so an approved retry can fit", async () => {
  const signed = mockApi();
  const account = privateKeyToAccount(generatePrivateKey());
  let rejectSignature = true;
  const signer = toClientEvmSigner({ address: account.address, signTypedData: async data => {
    if (rejectSignature) { rejectSignature = false; throw new Error("4001 user rejected signature"); }
    return account.signTypedData(data as Parameters<typeof account.signTypedData>[0]);
  } });
  const client = createPaymentClient("base-sepolia", signer, { totalBudgetUsdc: "0.001" });
  await assert.rejects(client.fetchWithPayment(`${API}/api/price/eth`), /4001/);
  assert.equal(client.getPaymentBudget().remainingUsdc, "0.001000");
  assert.equal((await client.fetchWithPayment(`${API}/api/price/eth`)).status, 200);
  assert.equal(signed.length, 1);
});

test("a wallet that finishes signing after timeout cannot submit the authorization", async () => {
  const signed = mockApi();
  const account = privateKeyToAccount(generatePrivateKey());
  let finishSigning!: () => void;
  const signer = toClientEvmSigner({ address: account.address, signTypedData: async data => {
    await new Promise<void>(resolve => { finishSigning = resolve; });
    return account.signTypedData(data as Parameters<typeof account.signTypedData>[0]);
  } });
  const client = createPaymentClient("base-sepolia", signer, { timeoutMs: 250, totalBudgetUsdc: "0.001" });
  await assert.rejects(client.fetchWithPayment(`${API}/api/price/eth`), /timed out/i);
  finishSigning();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(signed.length, 0);
  assert.equal(client.getPaymentBudget().remainingUsdc, "0.000000");
});

test("MCP quote and budget tools work without a private key and reject arbitrary URLs", async () => {
  const signed = mockApi();
  const server = createAgentTollServer({ network: "base-sepolia" });
  const client = new Client({ name: "offline-regression", version: "1.0.0" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    assert.equal(client.getServerVersion()?.version, MCP_VERSION);
    const initial: any = await client.callTool({ name: "get_payment_budget", arguments: {} });
    assert.equal(JSON.parse(initial.content[0].text).canSign, false);
    const quoted: any = await client.callTool({ name: "get_payment_quote", arguments: { path: "/api/price/eth" } });
    assert.equal(JSON.parse(quoted.content[0].text).amountUsdc, "0.001000");
    assert.equal(signed.length, 0);
    const invalid: any = await client.callTool({ name: "get_payment_quote", arguments: { path: "https://attacker.example/api/price/eth" } });
    assert.equal(invalid.isError, true);
    assert.match(invalid.content[0].text, /path|URL/i);
    const paid: any = await client.callTool({ name: "get_price", arguments: { symbol: "eth" } });
    assert.equal(paid.isError, true);
    assert.match(paid.content[0].text, /wallet/i);
    assert.equal(signed.length, 0);
  } finally { await client.close(); await server.close(); }
});

test("the real MCP get_price callback rejects a forged 50 USDC quote without signing", async () => {
  const signed = mockApi(quote("50000000"));
  const server = createAgentTollServer({ network: "base-sepolia", privateKey: generatePrivateKey() });
  const client = new Client({ name: "offline-regression", version: "1.0.0" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result: any = await client.callTool({ name: "get_price", arguments: { symbol: "eth" } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /ceiling/i);
    assert.equal(signed.length, 0);
  } finally { await client.close(); await server.close(); }
});

for (const [name, arguments_] of [
  ["get_price", { symbol: "eth" }],
  ["get_payment_quote", { path: "/api/price/eth" }],
] as const) {
  test(`cancelling MCP ${name} while its quote is pending aborts HTTP and cannot sign later`, async () => {
    const activeRequests: Request[] = [];
    let signedRequests = 0;
    let quoteStarted!: () => void;
    const started = new Promise<void>(resolve => { quoteStarted = resolve; });
    let releaseQuote!: (response: Response) => void;
    const delayedQuote = new Promise<Response>(resolve => { releaseQuote = resolve; });
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      activeRequests.push(request);
      if (request.headers.has("payment-signature")) {
        signedRequests++;
        return Response.json({ symbol: "eth", usd: 2000 });
      }
      quoteStarted();
      // Deliberately allow a late upstream response, even after the caller aborts.
      return delayedQuote;
    };
    const server = createAgentTollServer({ network: "base-sepolia", privateKey: generatePrivateKey() });
    const client = new Client({ name: "offline-cancellation-regression", version: "1.0.0" });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const abort = new AbortController();
      const pending = client.callTool({ name, arguments: arguments_ }, undefined, { signal: abort.signal });
      await started;
      const cancelled = assert.rejects(pending, /cancelled/i);
      abort.abort(new Error("Caller cancelled the MCP tool"));
      await cancelled;
      await new Promise<void>(resolve => setImmediate(resolve));
      const quoteWasAborted = activeRequests[0].signal.aborted;
      releaseQuote(paymentRequired());
      await new Promise<void>(resolve => setImmediate(resolve));
      const result: any = await client.callTool({ name: "get_payment_budget", arguments: {} });
      const budget = JSON.parse(result.content[0].text);
      assert.equal(signedRequests, 0, "A cancelled MCP callback must never submit a later payment");
      assert.equal(quoteWasAborted, true, "The MCP cancellation must reach the quote HTTP request");
      assert.equal(budget.spentUsdc, "0.000000");
      assert.equal(budget.reservedUsdc, "0.000000");
    } finally {
      releaseQuote(paymentRequired());
      await client.close();
      await server.close();
    }
  });
}

test("cancelling MCP after signing aborts HTTP and keeps the ambiguous amount reserved", async () => {
  const activeRequests: Request[] = [];
  let paymentStarted!: () => void;
  const started = new Promise<void>(resolve => { paymentStarted = resolve; });
  let releasePayment!: (response: Response) => void;
  const delayedPayment = new Promise<Response>(resolve => { releasePayment = resolve; });
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (!request.headers.has("payment-signature")) return paymentRequired();
    activeRequests.push(request);
    paymentStarted();
    return delayedPayment;
  };
  const server = createAgentTollServer({ network: "base-sepolia", privateKey: generatePrivateKey(), totalBudgetUsdc: "0.001" });
  const client = new Client({ name: "offline-cancellation-regression", version: "1.0.0" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const abort = new AbortController();
    const pending = client.callTool({ name: "get_price", arguments: { symbol: "eth" } }, undefined, { signal: abort.signal });
    await started;
    const cancelled = assert.rejects(pending, /cancelled/i);
    abort.abort(new Error("Caller cancelled the MCP tool"));
    await cancelled;
    await new Promise<void>(resolve => setImmediate(resolve));
    const paymentWasAborted = activeRequests[0].signal.aborted;
    releasePayment(Response.json({ symbol: "eth", usd: 2000 }));
    await new Promise<void>(resolve => setImmediate(resolve));
    const result: any = await client.callTool({ name: "get_payment_budget", arguments: {} });
    const budget = JSON.parse(result.content[0].text);
    assert.equal(paymentWasAborted, true);
    assert.equal(budget.reservedUsdc, "0.001000");
    assert.equal(budget.spentUsdc, "0.000000");
    assert.equal(budget.remainingUsdc, "0.000000");
  } finally {
    releasePayment(Response.json({}));
    await client.close();
    await server.close();
  }
});
