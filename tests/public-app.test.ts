import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

async function loadDemo(quoteRecipient: string) {
  const receiver = '0x1111111111111111111111111111111111111111';
  const listeners = new Map<string, () => Promise<void>>();
  const elements = new Map(['demo-out', 'demo-quote', 'demo-pay'].map(id => [id, {
    hidden: true, disabled: false, innerHTML: '', dataset: {},
    addEventListener: (_event: string, fn: () => Promise<void>) => listeners.set(id, fn),
  }]));
  let options: any;
  const quote = { x402Version: 2, accepts: [{ network: 'eip155:84532', payTo: quoteRecipient, amount: '4000' }] };
  runInNewContext(readFileSync(new URL('../public/app.js', import.meta.url), 'utf8'), {
    fetch: async (url: string) => url === '/api/base/fresh' ? new Response(null, { status: 402, headers: { 'payment-required': btoa(JSON.stringify(quote)) } }) : Response.json(url.includes('agent-card') ? { identity: { payTo: receiver }, interfaces: { http: { payment: { network: 'eip155:84532' } } } } : {}),
    document: { getElementById: (id: string) => elements.get(id) ?? null, querySelectorAll: () => [], documentElement: { classList: { add() {} } } },
    window: { scrollY: 0, location: { origin: 'http://localhost:4021' }, agentTollPay: async (_endpoint: string, _show: unknown, config: unknown) => { options = config; } },
    addEventListener() {}, matchMedia: () => ({ matches: true }), navigator: {}, innerWidth: 400,
    setTimeout, atob, AbortSignal,
  });
  await listeners.get('demo-quote')!();
  return { receiver, listeners, elements, getOptions: () => options };
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
