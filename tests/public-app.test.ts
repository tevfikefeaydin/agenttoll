import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

async function loadDemo(quoteRecipient: string, setup: {
  pay?: () => Promise<unknown>;
  lazy?: boolean;
} = {}) {
  const receiver = '0x1111111111111111111111111111111111111111';
  const listeners = new Map<string, () => Promise<void>>();
  const elements = new Map(['demo-out', 'demo-quote', 'demo-pay', 'demo-acknowledge'].map(id => [id, {
    hidden: true, disabled: false, innerHTML: '', dataset: {},
    addEventListener: (_event: string, fn: () => Promise<void>) => listeners.set(id, fn),
  }]));
  let options: any;
  let quoteRequests = 0;
  let paymentCalls = 0;
  const scripts: { src: string; onload?: () => void; onerror?: () => void; remove(): void }[] = [];
  const pay = async (_endpoint: string, _show: unknown, config: unknown) => {
    paymentCalls++;
    options = config;
    return setup.pay ? setup.pay() : { status: 'delivered' };
  };
  const browser = { scrollY: 0, location: { origin: 'http://localhost:4021' }, agentTollPay: setup.lazy ? undefined : pay };
  const quote = { x402Version: 2, accepts: [{ network: 'eip155:84532', payTo: quoteRecipient, amount: '4000' }] };
  runInNewContext(readFileSync(new URL('../public/app.js', import.meta.url), 'utf8'), {
    fetch: async (url: string) => {
      if (url === '/api/base/fresh') {
        quoteRequests++;
        return new Response(null, { status: 402, headers: { 'payment-required': btoa(JSON.stringify(quote)) } });
      }
      return Response.json(url.includes('agent-card') ? { identity: { payTo: receiver }, interfaces: { http: { payment: { network: 'eip155:84532' } } } } : {});
    },
    document: {
      getElementById: (id: string) => elements.get(id) ?? null,
      querySelectorAll: () => [], documentElement: { classList: { add() {} } },
      createElement: () => ({ src: '', remove() {} }),
      head: { appendChild: (script: typeof scripts[number]) => scripts.push(script) },
    },
    window: browser,
    addEventListener() {}, matchMedia: () => ({ matches: true }), navigator: {}, innerWidth: 400,
    setTimeout, atob, AbortSignal,
  });
  await listeners.get('demo-quote')!();
  return { receiver, listeners, elements, scripts, installPayment: () => { browser.agentTollPay = pay; },
    getOptions: () => options, quoteRequests: () => quoteRequests, paymentCalls: () => paymentCalls };
}

test('browser demo forwards the configured receiver and the inspected quote on custom hosts', async () => {
  const demo = await loadDemo('0x1111111111111111111111111111111111111111');
  assert.equal(demo.elements.get('demo-pay')!.hidden, false);
  await demo.listeners.get('demo-pay')!();
  assert.equal(demo.getOptions().recipient, demo.receiver);
  assert.equal(demo.getOptions().quote.accepts[0].payTo, demo.receiver);
});

test('browser demo does not enable payment for a quote that disagrees with deployment identity', async () => {
  const demo = await loadDemo('0x2222222222222222222222222222222222222222');
  assert.equal(demo.elements.get('demo-pay')!.hidden, true);
  assert.match(demo.elements.get('demo-out')!.innerHTML, /recipient|configuration/i);
});

test('homepage blocks quotes and payments after an uncertain authorization until wallet acknowledgement and a new quote', async () => {
  const demo = await loadDemo('0x1111111111111111111111111111111111111111', {
    pay: async () => ({ status: 'failed', authorizationPossible: true }),
  });
  await demo.listeners.get('demo-pay')!();
  assert.equal(demo.elements.get('demo-pay')!.hidden, true);
  assert.equal(demo.elements.get('demo-pay')!.disabled, true);
  assert.equal(demo.elements.get('demo-quote')!.disabled, true);
  assert.equal(demo.elements.get('demo-acknowledge')!.hidden, false);
  await demo.listeners.get('demo-pay')!();
  await demo.listeners.get('demo-quote')!();
  assert.equal(demo.paymentCalls(), 1);
  assert.equal(demo.quoteRequests(), 1);
  await demo.listeners.get('demo-acknowledge')!();
  assert.equal(demo.elements.get('demo-quote')!.disabled, false);
  assert.equal(demo.elements.get('demo-acknowledge')!.hidden, true);
  await demo.listeners.get('demo-pay')!();
  assert.equal(demo.paymentCalls(), 1);
  await demo.listeners.get('demo-quote')!();
  await demo.listeners.get('demo-pay')!();
  assert.equal(demo.quoteRequests(), 2);
  assert.equal(demo.paymentCalls(), 2);
});

for (const [name, pay] of [
  ['delivered', async () => ({ status: 'delivered' })],
  ['cancelled before authorization', async () => ({ status: 'failed', authorizationPossible: false })],
] as const) {
  test(`homepage requires a fresh quote after a payment is ${name}`, async () => {
    const demo = await loadDemo('0x1111111111111111111111111111111111111111', { pay });
    await demo.listeners.get('demo-pay')!();
    assert.equal(demo.elements.get('demo-pay')!.hidden, true);
    assert.equal(demo.elements.get('demo-quote')!.disabled, false);
    assert.equal(demo.elements.get('demo-acknowledge')!.hidden, true);
    await demo.listeners.get('demo-pay')!();
    assert.equal(demo.paymentCalls(), 1);
    await demo.listeners.get('demo-quote')!();
    await demo.listeners.get('demo-pay')!();
    assert.equal(demo.paymentCalls(), 2);
  });
}

for (const [name, pay] of [
  ['unexpected exception', async () => { throw new Error('Connection ended'); }],
  ['unrecognized outcome', async () => undefined],
] as const) {
  test(`homepage treats an ${name} after invoking payment as uncertain`, async () => {
    const demo = await loadDemo('0x1111111111111111111111111111111111111111', { pay });
    await demo.listeners.get('demo-pay')!();
    assert.equal(demo.elements.get('demo-quote')!.disabled, true);
    assert.equal(demo.elements.get('demo-acknowledge')!.hidden, false);
    await demo.listeners.get('demo-pay')!();
    assert.equal(demo.paymentCalls(), 1);
  });
}

test('homepage preserves reviewed terms and prevents quotes or duplicate payments during lazy loading and payment', async () => {
  let resolvePayment!: (value: unknown) => void;
  const result = new Promise(resolve => { resolvePayment = resolve; });
  const demo = await loadDemo('0x1111111111111111111111111111111111111111', { lazy: true, pay: () => result });
  const pending = demo.listeners.get('demo-pay')!();
  assert.equal(demo.scripts.length, 1);
  assert.equal(demo.elements.get('demo-quote')!.disabled, true);
  assert.equal(demo.elements.get('demo-pay')!.disabled, true);
  await demo.listeners.get('demo-quote')!();
  await demo.listeners.get('demo-pay')!();
  assert.equal(demo.quoteRequests(), 1);
  assert.equal(demo.scripts.length, 1);
  demo.installPayment();
  demo.scripts[0].onload!();
  await Promise.resolve();
  assert.equal(demo.paymentCalls(), 1);
  assert.equal(demo.getOptions().recipient, demo.receiver);
  assert.equal(demo.getOptions().quote.accepts[0].amount, '4000');
  await demo.listeners.get('demo-quote')!();
  await demo.listeners.get('demo-pay')!();
  assert.equal(demo.quoteRequests(), 1);
  assert.equal(demo.paymentCalls(), 1);
  resolvePayment({ status: 'delivered' });
  await pending;
  assert.equal(demo.elements.get('demo-quote')!.disabled, false);
});

test('a failed payment library load permits a fresh quote without requiring a wallet acknowledgement', async () => {
  const demo = await loadDemo('0x1111111111111111111111111111111111111111', { lazy: true });
  const pending = demo.listeners.get('demo-pay')!();
  demo.scripts[0].onerror!();
  await pending;
  assert.equal(demo.paymentCalls(), 0);
  assert.equal(demo.elements.get('demo-quote')!.disabled, false);
  assert.equal(demo.elements.get('demo-acknowledge')!.hidden, true);
  assert.equal(demo.elements.get('demo-pay')!.hidden, true);
  assert.match(demo.elements.get('demo-out')!.innerHTML, /load the payment library/i);
});

test('homepage statistics separate operator transfers and show incomplete coverage', async () => {
  const counter = { innerHTML: '', textContent: '', title: '' };
  runInNewContext(readFileSync(new URL('../public/app.js', import.meta.url), 'utf8'), {
    fetch: async () => Response.json({ tollsCollected: 309, revenueUsdc: 0.891,
      externalPayers: 21, externalTolls: 168, partial: true }),
    document: { getElementById: (id: string) => id === 'toll-counter' ? counter : null,
      querySelectorAll: () => [], documentElement: { classList: { add() {} } } },
    window: { scrollY: 0 }, addEventListener() {}, matchMedia: () => ({ matches: true }), navigator: {}, innerWidth: 400,
    setTimeout, atob, AbortSignal,
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(counter.innerHTML, /168/);
  assert.doesNotMatch(counter.innerHTML, /309/);
  assert.match(counter.innerHTML, /external|outside/i);
  assert.match(counter.innerHTML, /partial/i);
  assert.match(counter.title, /operator|test/i);
});
