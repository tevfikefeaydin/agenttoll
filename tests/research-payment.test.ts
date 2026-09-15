import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { ResearchPayments, type DeliveredOutcome, type ResearchQuote, type Show } from '../web/research-payment.js';
import type { BrowserPaymentOutcome, pay } from '../web/demo.js';

const API = 'https://agenttoll.app';
const RECIPIENT = '0xe55359021a6a22d8385b827405991c56075f56f8';
const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';
const C = '0x3333333333333333333333333333333333333333';
const SAFETY = `/api/base/safety/${A}`;
const SECOND = `/api/base/safety/${B}`;
const THIRD = `/api/base/safety/${C}`;
const PORTFOLIO = `/api/base/portfolio/${A}?minValue=0&limit=50`;
const previousWindow = (globalThis as any).window;
const previousFetch = globalThis.fetch;
afterEach(() => { (globalThis as any).window = previousWindow; globalThis.fetch = previousFetch; });
const show: Show = () => {};
const receipt = '0x' + 'a'.repeat(64);

function paymentQuote(path: string, amount = '3000', changes: Record<string, unknown> = {}) {
  return {
    x402Version: 2, resource: { url: API + path },
    accepts: [{ scheme: 'exact', network: 'eip155:8453', amount, payTo: RECIPIENT,
      maxTimeoutSeconds: 60, asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      extra: { name: 'USD Coin', version: '2' }, ...changes }],
  };
}
function identity() {
  return { url: API, identity: { payTo: RECIPIENT }, dataNetwork: 'base',
    interfaces: { http: { baseUrl: API, payment: { protocol: 'x402', version: 2, network: 'eip155:8453', asset: 'USDC' } } } };
}
function delivered(data: unknown = { address: A }): DeliveredOutcome {
  return { status: 'delivered', data, transaction: receipt, network: 'base', signed: true };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}
function fixture(options: {
  identity?: unknown;
  quote?: (path: string) => unknown;
  pay?: typeof pay;
  fetch?: typeof fetch;
} = {}) {
  let now = 1_000_000;
  const requests: Request[] = [];
  const payments: { path: string; options: Parameters<typeof pay>[2] }[] = [];
  (globalThis as any).window = { location: { origin: API } };
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    assert.equal(new URL(request.url).origin, API);
    assert.equal(request.method, 'GET');
    assert.equal(request.headers.has('payment-signature'), false);
    if (options.fetch) return options.fetch(input, init);
    const url = new URL(request.url);
    if (url.pathname === '/.well-known/agent-card.json') return Response.json(options.identity ?? identity());
    return new Response(null, { status: 402, headers: { 'payment-required': Buffer.from(JSON.stringify(
      options.quote?.(url.pathname + url.search) ?? paymentQuote(url.pathname + url.search),
    )).toString('base64') } });
  };
  const payer: typeof pay = async (path, display, terms) => {
    payments.push({ path, options: terms });
    return options.pay ? options.pay(path, display, terms) : delivered();
  };
  const research = new ResearchPayments({ fetch: fetcher, pay: payer, now: () => now });
  return { research, requests, payments, setTime: (value: number) => { now = value; } };
}

test('research preview adds micro-USDC exactly and never invokes a wallet', async () => {
  const f = fixture({ quote: path => paymentQuote(path, path === SAFETY ? '1001' : '2002') });
  const batch = await f.research.quote([SAFETY, SECOND]);
  assert.equal(batch.totalUsdc, '0.003003');
  assert.deepEqual(batch.items.map(item => item.amountUsdc), ['0.001001', '0.002002']);
  assert.equal(batch.recipient, RECIPIENT);
  assert.equal(batch.network, 'base');
  assert.equal(f.payments.length, 0);
  assert.equal(f.requests.length, 3);
  assert.equal(f.research.busy, false);
});

test('research accepts one separately quoted portfolio lookup with bounded canonical query', async () => {
  const f = fixture();
  const batch = await f.research.quote([PORTFOLIO]);
  assert.equal(batch.items[0].path, PORTFOLIO);
  assert.equal(batch.totalUsdc, '0.003000');
});

for (const [label, paths] of [
  ['external URL', [API + SAFETY]], ['protocol-relative URL', ['//agenttoll.app' + SAFETY]],
  ['unregistered endpoint', ['/api/price/eth']], ['escaped path', [SAFETY.replace('/base/', '/base/../base/')]],
  ['encoded address', [SAFETY.replace('0x', '%30x')]], ['unexpected safety query', [SAFETY + '?extra=1']],
  ['repeated token', [SAFETY, SAFETY]], ['mixed purchases', [SAFETY, PORTFOLIO]],
  ['oversized batch', [SAFETY, SECOND, THIRD, `/api/base/safety/0x${'4'.repeat(40)}`, `/api/base/safety/0x${'5'.repeat(40)}`, `/api/base/safety/0x${'6'.repeat(40)}`]],
  ['duplicate query', [PORTFOLIO + '&limit=1']], ['large limit', [PORTFOLIO.replace('50', '51')]],
  ['noncanonical query', [PORTFOLIO.replace('minValue=0', 'minValue=0e0')]], ['unknown query', [PORTFOLIO + '&recipient=' + B]],
  ['zero address', [`/api/base/safety/0x${'0'.repeat(40)}`]], ['empty batch', []],
] as [string, string[]][]) {
  test(`research rejects ${label} before network or wallet access`, async () => {
    const f = fixture();
    await assert.rejects(f.research.quote(paths));
    assert.equal(f.requests.length, 0);
    assert.equal(f.payments.length, 0);
  });
}

test('canonical address duplicates cannot purchase the same token twice', async () => {
  const address = `0x${'a'.repeat(40)}`;
  const f = fixture();
  await assert.rejects(f.research.quote([`/api/base/safety/${address}`, `/api/base/safety/${address.toUpperCase().replace('0X', '0x')}`]));
  assert.equal(f.requests.length, 0);
});

for (const [label, change] of [
  ['recipient', { payTo: B }], ['network', { network: 'eip155:1' }],
  ['asset', { asset: B }], ['price ceiling', { amount: '3001' }],
  ['signing domain', { extra: { name: 'USDC', version: '2' } }],
] as const) {
  test(`research rejects an invalid quote ${label} before payment`, async () => {
    const f = fixture({ quote: path => paymentQuote(path, '3000', change) });
    await assert.rejects(f.research.quote([SAFETY]));
    assert.equal(f.payments.length, 0);
  });
}

test('research rejects a same-host card claiming an external API origin', async () => {
  const card = identity();
  card.interfaces.http.baseUrl = 'https://attacker.invalid';
  const f = fixture({ identity: card });
  await assert.rejects(f.research.quote([SAFETY]));
  assert.equal(f.payments.length, 0);
  assert.equal(f.requests.length, 1);
});

test('research cannot replace the hosted recipient with a matching malicious card and quote', async () => {
  const card = identity();
  card.identity.payTo = B;
  const f = fixture({ identity: card, quote: path => paymentQuote(path, '3000', { payTo: B }) });
  await assert.rejects(f.research.quote([SAFETY]));
  assert.equal(f.payments.length, 0);
});

test('a portfolio resource cannot change the displayed query terms', async () => {
  const f = fixture({ quote: () => paymentQuote(PORTFOLIO.replace('limit=50', 'limit=1')) });
  await assert.rejects(f.research.quote([PORTFOLIO]));
  assert.equal(f.payments.length, 0);
});

test('old, copied and expired previews cannot authorize a payment', async () => {
  const f = fixture();
  const first = await f.research.quote([SAFETY]);
  const second = await f.research.quote([SECOND]);
  assert.equal((await f.research.run(first, show, () => {})).stopReason, 'invalid');
  const third = await f.research.quote([THIRD]);
  assert.equal((await f.research.run({ ...third }, show, () => {})).stopReason, 'invalid');
  const fresh = await f.research.quote([SAFETY]);
  f.setTime(1_060_001);
  assert.equal((await f.research.run(fresh, show, () => {})).stopReason, 'stale');
  assert.equal(f.payments.length, 0);
  assert.equal(second.items[0].path, SECOND);
});

test('preview terms are deeply immutable and a completed batch is single-use', async () => {
  const raw = paymentQuote(SAFETY);
  const f = fixture({ quote: () => raw });
  const batch = await f.research.quote([SAFETY]);
  raw.accepts[0].amount = '1';
  assert.equal(Reflect.set(batch, 'totalUsdc', '0.000001'), false);
  assert.equal(Reflect.set(batch.items[0], 'path', SECOND), false);
  assert.equal(Reflect.set((batch.items[0].quote as any).accepts[0], 'amount', '1'), false);
  const result = await f.research.run(batch, show, () => {});
  assert.equal(result.stopReason, 'complete');
  assert.equal((f.payments[0].options?.quote as any).accepts[0].amount, '3000');
  assert.equal(f.payments[0].options?.recipient, RECIPIENT);
  assert.equal(f.payments[0].options?.showRaw, false);
  assert.equal((await f.research.run(batch, show, () => {})).stopReason, 'invalid');
  assert.equal(f.payments.length, 1);
});

test('sequential payment retains the first receipt and stops when the next wallet request is rejected', async () => {
  const gate = deferred<BrowserPaymentOutcome>();
  const f = fixture({ pay: async path => path === SAFETY ? gate.promise : { status: 'failed', authorizationPossible: false } });
  const batch = await f.research.quote([SAFETY, SECOND, THIRD]);
  const received: string[] = [];
  const pending = f.research.run(batch, show, request => { received.push(request.path); });
  await Promise.resolve();
  assert.equal(f.research.busy, true);
  assert.equal(f.payments.length, 1);
  assert.equal((await f.research.run(batch, show, () => {})).stopReason, 'busy');
  await assert.rejects(f.research.quote([THIRD]), /progress|busy/i);
  gate.resolve(delivered());
  const result = await pending;
  assert.equal(result.completed, 1);
  assert.equal(result.stopReason, 'failed');
  assert.deepEqual(received, [SAFETY]);
  assert.equal(result.results[0].outcome.transaction, receipt);
  assert.equal(f.payments.length, 2);
  assert.equal(f.research.blocked, false);
  assert.equal(f.research.busy, false);
});

test('a batch stops with retained results if its terms expire between wallet authorizations', async () => {
  const f = fixture({ pay: async () => { f.setTime(1_061_000); return delivered(); } });
  const batch = await f.research.quote([SAFETY, SECOND]);
  const result = await f.research.run(batch, show, () => {});
  assert.equal(result.stopReason, 'stale');
  assert.equal(result.completed, 1);
  assert.equal(f.payments.length, 1);
});

for (const [label, payer] of [
  ['possible authorization', async () => ({ status: 'failed', authorizationPossible: true } as const)],
  ['unexpected exception', async () => { throw new Error('Connection ended'); }],
  ['malformed outcome', async () => null as unknown as BrowserPaymentOutcome],
] as [string, typeof pay][]) {
  test(`${label} blocks every later purchase until explicit acknowledgement and a new quote`, async () => {
    const f = fixture({ pay: payer });
    const batch = await f.research.quote([SAFETY, SECOND]);
    assert.equal((await f.research.run(batch, show, () => {})).stopReason, 'uncertain');
    assert.equal(f.research.blocked, true);
    const next = await f.research.quote([THIRD]);
    assert.equal((await f.research.run(next, show, () => {})).stopReason, 'blocked');
    assert.equal(f.payments.length, 1);
    f.research.acknowledgeUncertain();
    assert.equal(f.research.blocked, false);
    assert.equal((await f.research.run(next, show, () => {})).stopReason, 'invalid');
  });
}

test('malformed delivered data retains its raw payload and receipt, then requires acknowledgement', async () => {
  const raw = { malformed: true };
  const f = fixture({ pay: async () => delivered(raw) });
  const batch = await f.research.quote([SAFETY, SECOND]);
  const result = await f.research.run(batch, show, () => { throw new Error('Unexpected token report'); });
  assert.equal(result.stopReason, 'delivery-invalid');
  assert.equal(result.completed, 1);
  assert.deepEqual(result.results[0].outcome.data, raw);
  assert.equal(result.results[0].outcome.transaction, receipt);
  assert.equal(f.research.blocked, true);
  assert.equal(f.payments.length, 1);
});

test('a consumer that mutates data before failing cannot overwrite the retained delivered payload', async () => {
  const f = fixture({ pay: async () => delivered({ address: A, nested: { value: 7 } }) });
  const batch = await f.research.quote([SAFETY]);
  const result = await f.research.run(batch, show, (_request, outcome) => {
    (outcome.data as any).nested.value = 0;
    throw new Error('Report could not be saved');
  });
  assert.equal(result.stopReason, 'delivery-invalid');
  assert.equal((result.results[0].outcome.data as any).nested.value, 7);
  assert.equal(result.results[0].outcome.transaction, receipt);
});

test('aborted and superseded previews cannot revive obsolete terms even when transport ignores abort', async () => {
  const delayed = deferred<Response>();
  let first = true;
  const f = fixture({ fetch: async input => {
    const url = new URL(new Request(input).url);
    if (url.pathname === '/.well-known/agent-card.json') return Response.json(identity());
    if (first) { first = false; return delayed.promise; }
    return new Response(null, { status: 402, headers: { 'payment-required': Buffer.from(JSON.stringify(paymentQuote(url.pathname))).toString('base64') } });
  } });
  const old = f.research.quote([SAFETY]);
  const oldOutcome = old.then(() => null, error => error);
  for (let poll = 0; f.requests.length < 2 && poll < 100; poll++) await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(f.requests.length, 2);
  const current = await f.research.quote([SECOND]);
  assert.match(String(await oldOutcome), /supersed|abort/i);
  delayed.resolve(new Response(null, { status: 402, headers: { 'payment-required': Buffer.from(JSON.stringify(paymentQuote(SAFETY))).toString('base64') } }));
  await Promise.resolve();
  assert.equal((await f.research.run(current, show, () => {})).stopReason, 'complete');
  assert.equal(f.payments[0].path, SECOND);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(f.research.quote([SAFETY], controller.signal));
  assert.equal(f.research.busy, false);
});

test('aborting a live preview releases busy state without leaving a usable earlier quote', async () => {
  const f = fixture();
  const first = await f.research.quote([SAFETY]);
  const controller = new AbortController();
  const pending = f.research.quote([SECOND], controller.signal);
  controller.abort(new Error('User aborted quote'));
  await assert.rejects(pending, /aborted/i);
  assert.equal(f.research.busy, false);
  assert.equal((await f.research.run(first, show, () => {})).stopReason, 'invalid');
  assert.equal(f.payments.length, 0);
});

for (const [label, makeResponse] of [
  ['cross-origin response', () => { const response = Response.json(identity()); Object.defineProperty(response, 'url', { value: 'https://attacker.invalid/.well-known/agent-card.json' }); return response; }],
  ['redirect', () => new Response(null, { status: 302, headers: { location: API } })],
  ['oversized identity', () => Response.json({ ...identity(), extra: 'x'.repeat(65_536) })],
] as [string, () => Response][]) {
  test(`free preview rejects ${label} before asking for a quote or wallet`, async () => {
    const f = fixture({ fetch: async () => makeResponse() });
    await assert.rejects(f.research.quote([SAFETY]));
    assert.equal(f.requests.length, 1);
    assert.equal(f.payments.length, 0);
    assert.equal(f.research.busy, false);
  });
}

function realBrowserPayment(changedLiveQuote = false) {
  const account = privateKeyToAccount(generatePrivateKey());
  const walletRequests: string[] = [];
  const signedMessages: any[] = [];
  const paidPaths: string[] = [];
  let previewFinished = false;
  (globalThis as any).window = { location: { origin: API }, ethereum: {
    async request({ method, params }: { method: string; params?: any[] }) {
      walletRequests.push(method);
      if (method === 'eth_requestAccounts') return [account.address];
      if (method === 'eth_chainId') return '0x2105';
      if (method === 'eth_getCode') return '0x';
      if (method === 'eth_signTypedData_v4') {
        const typedData = JSON.parse(params?.[1]);
        signedMessages.push(typedData);
        return account.signTypedData(typedData);
      }
      throw new Error(`Unexpected wallet method ${method}`);
    },
  } };
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    assert.equal(url.origin, API);
    if (url.pathname === '/.well-known/agent-card.json') return Response.json(identity());
    if (!request.headers.has('payment-signature')) return new Response(null, { status: 402, headers: {
      'payment-required': Buffer.from(JSON.stringify(paymentQuote(url.pathname, changedLiveQuote && previewFinished ? '2000' : '3000'))).toString('base64'),
    } });
    paidPaths.push(url.pathname);
    return Response.json({ address: url.pathname.split('/').at(-1) }, { headers: {
      'payment-response': Buffer.from(JSON.stringify({ success: true, transaction: receipt, network: 'eip155:8453', payer: account.address })).toString('base64'),
    } });
  };
  return { research: new ResearchPayments(), walletRequests, signedMessages, paidPaths, finishPreview: () => { previewFinished = true; } };
}

test('the production pay implementation requests one wallet authorization per report in a sequential batch', async () => {
  const f = realBrowserPayment();
  const batch = await f.research.quote([SAFETY, SECOND]);
  assert.equal(f.walletRequests.length, 0);
  f.finishPreview();
  const result = await f.research.run(batch, show, () => {});
  assert.equal(result.stopReason, 'complete');
  assert.equal(result.completed, 2);
  assert.deepEqual(f.paidPaths, [SAFETY, SECOND]);
  assert.equal(f.signedMessages.length, 2);
  assert.deepEqual(f.signedMessages.map(data => data.message.value), ['3000', '3000']);
  assert.equal(result.results[0].outcome.transaction, receipt);
  assert.equal(result.results[1].outcome.transaction, receipt);
});

test('the production pay implementation rejects a changed live quote without signing or silently retrying', async () => {
  const f = realBrowserPayment(true);
  const batch = await f.research.quote([SAFETY, SECOND]);
  f.finishPreview();
  const result = await f.research.run(batch, show, () => {});
  assert.equal(result.stopReason, 'failed');
  assert.equal(result.completed, 0);
  assert.equal(f.signedMessages.length, 0);
  assert.equal(f.paidPaths.length, 0);
  assert.equal(f.research.blocked, false);
});
