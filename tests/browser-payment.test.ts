import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const originalFetch = globalThis.fetch;
const previousWindow = (globalThis as any).window;
(globalThis as any).window = { location: { origin: "https://agenttoll.app" } };
await import("../web/demo.js");
const pay = (globalThis as any).window.agentTollPay;
afterEach(() => {
  globalThis.fetch = originalFetch;
  (globalThis as any).window = previousWindow;
});

const API = "https://agenttoll.app";
const ENDPOINT = "/api/price/eth";
const RECIPIENT = "0xe55359021a6a22d8385b827405991c56075f56f8";

function quote(testnet = false, changes: Record<string, unknown> = {}) {
  return {
    x402Version: 2,
    resource: { url: API + ENDPOINT },
    accepts: [{
      scheme: "exact", network: testnet ? "eip155:84532" : "eip155:8453",
      amount: "1000", payTo: RECIPIENT, maxTimeoutSeconds: 60,
      asset: testnet ? "0x036CbD53842c5426634e7929541eC2318f3dCF7e" : "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      extra: { name: testnet ? "USDC" : "USD Coin", version: "2" }, ...changes,
    }],
  };
}

function browser(options: {
  testnet?: boolean; signError?: string; accountError?: string; wrongChain?: boolean;
  contract?: boolean; liveQuote?: ReturnType<typeof quote>; status?: number; reason?: string;
  changeChainOnSign?: boolean;
} = {}) {
  const account = privateKeyToAccount(generatePrivateKey());
  const shown: { html: string; tone: string }[] = [];
  const signatures: any[] = [];
  const codeAddresses: unknown[] = [];
  const walletRequests: string[] = [];
  let chainChecks = 0;
  let chainId = options.testnet ? "0x14a34" : "0x2105";
  const provider = {
    async request({ method, params }: { method: string; params?: any[] }) {
      walletRequests.push(method);
      if (method === "eth_requestAccounts") {
        if (options.accountError) throw new Error(options.accountError);
        return [account.address];
      }
      if (method === "eth_chainId") {
        chainChecks++;
        return options.wrongChain || (options.changeChainOnSign && chainChecks > 1) ? "0x1" : chainId;
      }
      if (method === "wallet_switchEthereumChain") { chainId = params?.[0].chainId; return null; }
      if (method === "eth_getCode") { codeAddresses.push(params?.[0]); return options.contract ? "0x6000" : "0x"; }
      if (method === "eth_signTypedData_v4") {
        const data = JSON.parse(params?.[1]);
        if (options.signError) throw new Error(options.signError);
        signatures.push(data);
        return account.signTypedData(data);
      }
      throw new Error(`Unexpected wallet method ${method}`);
    },
  };
  (globalThis as any).window = { ethereum: provider, location: { origin: API } };
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    assert.equal(new URL(request.url).origin, API, "Browser must not use an external RPC");
    if (!request.headers.has("payment-signature")) {
      return new Response(null, { status: 402, headers: {
        "payment-required": Buffer.from(JSON.stringify(options.liveQuote ?? quote(options.testnet))).toString("base64"),
      } });
    }
    if (options.status && options.status !== 200) return new Response(null, {
      status: options.status,
      headers: { "payment-required": Buffer.from(JSON.stringify({ ...quote(options.testnet), error: options.reason })).toString("base64") },
    });
    return Response.json({ symbol: "eth", usd: 2000 });
  };
  return {
    account, signatures, codeAddresses, shown, walletRequests,
    show: (html: string, tone: string) => { shown.push({ html, tone }); },
  };
}

test("signature verification errors render a useful error instead of a catch-scope ReferenceError", async () => {
  const fixture = browser({ signError: "invalid_signature", contract: true });
  await assert.doesNotReject(pay(API + ENDPOINT, fixture.show, { quote: quote() }));
  assert.equal(fixture.shown.at(-1)?.tone, "err");
  assert.match(fixture.shown.at(-1)?.html ?? "", /facilitator|signature/i);
  assert.deepEqual(fixture.codeAddresses, [fixture.account.address]);
});

test("a Base Sepolia quote selects and signs for Base Sepolia", async () => {
  const fixture = browser({ testnet: true });
  await pay(API + ENDPOINT, fixture.show, { quote: quote(true) });
  assert.equal(fixture.shown.at(-1)?.tone, "ok");
  assert.equal(fixture.signatures.length, 1);
  assert.equal(Number(fixture.signatures[0].domain.chainId), 84532);
  assert.equal(fixture.signatures[0].message.to.toLowerCase(), RECIPIENT);
  assert.equal(fixture.signatures[0].message.value, "1000");
});

test("a changed quote is rejected before the wallet is asked to sign", async () => {
  const fixture = browser({ liveQuote: quote(false, { amount: "900" }) });
  await pay(API + ENDPOINT, fixture.show, { quote: quote() });
  assert.equal(fixture.shown.at(-1)?.tone, "err");
  assert.match(fixture.shown.at(-1)?.html ?? "", /changed|quote/i);
  assert.equal(fixture.signatures.length, 0);
});

test("wallet account cancellation returns an actionable message", async () => {
  const fixture = browser({ accountError: "4001 user denied connection" });
  await assert.doesNotReject(pay(API + ENDPOINT, fixture.show, { quote: quote() }));
  assert.equal(fixture.shown.at(-1)?.tone, "err");
  assert.match(fixture.shown.at(-1)?.html ?? "", /rejected.*no payment/i);
  assert.equal(fixture.signatures.length, 0);
});

test("wallet signature cancellation returns a useful error without submitting payment", async () => {
  const fixture = browser({ signError: "4001 user rejected signature" });
  await assert.doesNotReject(pay(API + ENDPOINT, fixture.show, { quote: quote() }));
  assert.equal(fixture.shown.at(-1)?.tone, "err");
  assert.match(fixture.shown.at(-1)?.html ?? "", /no payment was submitted/i);
  assert.equal(fixture.signatures.length, 0);
});

test("insufficient USDC errors identify the quoted network", async () => {
  const fixture = browser({ testnet: true, signError: "insufficient USDC balance" });
  await pay(API + ENDPOINT, fixture.show, { quote: quote(true) });
  assert.equal(fixture.shown.at(-1)?.tone, "err");
  assert.match(fixture.shown.at(-1)?.html ?? "", /USDC on Base Sepolia/i);
});

test("a failed network switch never reaches signing", async () => {
  const fixture = browser({ testnet: true, wrongChain: true });
  await pay(API + ENDPOINT, fixture.show, { quote: quote(true) });
  assert.equal(fixture.shown.at(-1)?.tone, "err");
  assert.match(fixture.shown.at(-1)?.html ?? "", /still not on Base Sepolia/i);
  assert.equal(fixture.signatures.length, 0);
});

test("a network change while fetching the quote is caught at the signing boundary", async () => {
  const fixture = browser({ changeChainOnSign: true });
  await pay(API + ENDPOINT, fixture.show, { quote: quote() });
  assert.equal(fixture.shown.at(-1)?.tone, "err");
  assert.match(fixture.shown.at(-1)?.html ?? "", /changed network/i);
  assert.equal(fixture.signatures.length, 0);
});

for (const [name, change] of [
  ["unsupported network", { network: "eip155:1" }],
  ["untrusted recipient", { payTo: "0x0000000000000000000000000000000000000001" }],
  ["wrong asset", { asset: "0x0000000000000000000000000000000000000001" }],
  ["excessive price", { amount: "50000000" }],
] as const) {
  test(`${name} in the displayed quote is rejected before prompting a wallet`, async () => {
    const fixture = browser();
    await pay(API + ENDPOINT, fixture.show, { quote: quote(false, change) });
    assert.equal(fixture.shown.at(-1)?.tone, "err");
    assert.equal(fixture.walletRequests.length, 0);
    assert.equal(fixture.signatures.length, 0);
  });
}

test("a facilitator failure is shown as an error with the quoted network", async () => {
  const fixture = browser({ testnet: true, status: 402, reason: "insufficient balance" });
  await pay(API + ENDPOINT, fixture.show, { quote: quote(true) });
  assert.equal(fixture.shown.at(-1)?.tone, "err");
  assert.match(fixture.shown.at(-1)?.html ?? "", /Base Sepolia/i);
  assert.doesNotMatch(fixture.shown.at(-1)?.html ?? "", /nothing was charged/i);
});

test("an unfinished browser fetch is aborted and reported as a timeout", async () => {
  const fixture = browser();
  let aborted = false;
  let directAborted = false;
  const requests: Request[] = [];
  const onDirectAbort = () => { directAborted = true; };
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    // A real transport retains its active HTTP request until completion.
    requests.push(request);
    init?.signal?.addEventListener("abort", onDirectAbort);
    return new Promise<Response>((_resolve, reject) => {
      request.signal.addEventListener("abort", () => { aborted = true; reject(request.signal.reason); });
    });
  };
  await pay(API + ENDPOINT, fixture.show, { quote: quote(), timeoutMs: 250 });
  assert.equal(fixture.shown.at(-1)?.tone, "err");
  assert.match(fixture.shown.at(-1)?.html ?? "", /timed out/i);
  assert.equal(requests.length, 1, "The request reached the external HTTP boundary");
  assert.equal(directAborted, true);
  assert.equal(requests[0].signal.aborted, true);
  assert.equal(aborted, true);
  assert.equal(fixture.signatures.length, 0);
});

test("missing wallet produces an install hint without a rejected promise", async () => {
  const fixture = browser();
  delete (globalThis as any).window.ethereum;
  await assert.doesNotReject(pay(API + ENDPOINT, fixture.show, { quote: quote() }));
  assert.equal(fixture.shown.at(-1)?.tone, "err");
  assert.match(fixture.shown.at(-1)?.html ?? "", /No browser wallet/i);
});
