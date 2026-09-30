import assert from 'node:assert/strict';
import test from 'node:test';

class Control {
  value = ''; textContent = ''; innerHTML = ''; hidden = true; disabled = false;
  checked = false; dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  handlers = new Map<string, (event: { preventDefault(): void }) => unknown>();
  addEventListener(name: string, handler: (event: { preventDefault(): void }) => unknown) { this.handlers.set(name, handler); }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  removeAttribute(name: string) { this.attributes.delete(name); }
  focus() {}
  async dispatch(name: string) { await this.handlers.get(name)?.({ preventDefault() {} }); }
}

test('inspection example is free, invalidates quotes, and recovers from a failed price check without wallet access', async () => {
  const globals = globalThis as any;
  const previous = { document: globals.document, window: globals.window, location: globals.location, fetch: globals.fetch };
  const controls = new Map<string, Control>();
  const control = (id: string) => { if (!controls.has(id)) controls.set(id, new Control()); return controls.get(id)!; };
  const token = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
  control('sample-token').dataset.token = token;
  const origin = 'https://agenttoll.app';
  const recipient = '0xe55359021a6a22d8385b827405991c56075f56f8';
  const requests: string[] = [];
  let walletCalls = 0, fail = false;
  globals.document = { getElementById: control };
  globals.location = { origin, search: '' };
  globals.window = { location: globals.location, ethereum: { request() { walletCalls++; throw new Error('Unexpected wallet access'); } } };
  globals.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), origin);
    assert.equal(new Headers(init?.headers).has('payment-signature'), false);
    requests.push(url.pathname);
    if (fail) throw new TypeError('Failed to fetch');
    if (url.pathname.includes('agent-card')) return Response.json({ identity: { payTo: recipient }, interfaces: { http: { payment: { network: 'eip155:8453' } } } });
    const quote = { x402Version: 2, resource: { url: url.href }, accepts: [{ scheme: 'exact', network: 'eip155:8453', amount: '3000', payTo: recipient, maxTimeoutSeconds: 60, asset: token, extra: { name: 'USD Coin', version: '2' } }] };
    return new Response(null, { status: 402, headers: { 'payment-required': Buffer.from(JSON.stringify(quote)).toString('base64') } });
  };
  const idle = async () => { for (let i = 0; i < 50 && control('quote-button').disabled; i++) await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(control('quote-button').disabled, false); };
  try {
    await import('../web/inspect.js');
    await control('sample-token').dispatch('click');
    assert.equal(control('token-address').value, token);
    assert.equal(requests.length, 0);
    assert.equal(walletCalls, 0);
    await control('inspect-form').dispatch('submit'); await idle();
    assert.equal(control('price-box').hidden, false);
    assert.match(control('quote-network').textContent, /Base/);
    assert.match(control('payment-preparation').textContent, /0\.003 USDC/);
    await control('sample-token').dispatch('click');
    assert.equal(control('price-box').hidden, true);
    await control('pay-button').dispatch('click');
    assert.equal(walletCalls, 0);
    fail = true;
    await control('inspect-form').dispatch('submit'); await idle();
    assert.equal(control('price-box').hidden, true);
    assert.match(control('inspection-status').innerHTML, /No payment was requested/);
    assert.match(control('inspection-status').innerHTML, /Check price again/);
    fail = false;
    await control('inspect-form').dispatch('submit'); await idle();
    assert.equal(control('price-box').hidden, false);
    assert.equal(walletCalls, 0);
  } finally { Object.assign(globals, previous); }
});
