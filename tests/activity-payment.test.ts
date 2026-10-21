import test from 'node:test';
import assert from 'node:assert/strict';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { toClientEvmSigner } from '@x402/evm';
import { createPaymentClient } from '../src/payment-policy.js';

test('Ankr activity completes payment only after valid data and sanitizes failures', async t => {
  process.env.DOTENV_CONFIG_PATH = 'agenttoll-test-absent.env';
  process.env.ADDRESS = '0x1111111111111111111111111111111111111111';
  process.env.NETWORK = 'base-sepolia';
  process.env.FACILITATOR_URL = 'https://facilitator.activity.invalid';
  process.env.ADDRESS_ACTIVITY_PROVIDER = 'ankr';
  process.env.ANKR_API_KEY = 'test-only-ankr-credential';
  delete process.env.PAUSED_ENDPOINTS;
  delete process.env.VERCEL;
  const account = privateKeyToAccount(generatePrivateKey());
  const nativeFetch = globalThis.fetch;
  let mode = 'ok', providerCalls = 0, verifyCalls = 0, settleCalls = 0;
  const logs: unknown[] = [];
  t.mock.method(console, 'log', (line: unknown) => { logs.push(line); });
  t.mock.method(console, 'error', (line: unknown) => { logs.push(line); });
  t.mock.method(console, 'warn', (line: unknown) => { logs.push(line); });
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('http://127.0.0.1:')) return nativeFetch(input, init);
    if (url.endsWith('/supported')) return Response.json({ kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:84532' }], extensions: [], signers: {} });
    if (url.endsWith('/verify')) { verifyCalls++; return Response.json({ isValid: true, payer: account.address }); }
    if (url.endsWith('/settle')) {
      settleCalls++;
      return Response.json({ success: true, transaction: '0x' + 'ab'.repeat(32), network: 'eip155:84532', payer: account.address });
    }
    if (url.startsWith('https://rpc.ankr.com/multichain/')) {
      providerCalls++;
      if (mode === 'denied') return new Response('test-only-ankr-credential PRIVATE-PROVIDER-DETAIL', { status: 403 });
      if (mode === 'transport') throw new Error(url + ' PRIVATE-PROVIDER-DETAIL');
      const a = JSON.parse(String(init?.body)).params.address;
      return Response.json({ jsonrpc: '2.0', id: 1, result: { nextPageToken: null, transactions: [{
        blockchain: 'base', hash: '0x' + 'cd'.repeat(32), from: a, to: null, value: '0x0', input: '0x', status: '0x0',
        blockNumber: '0x64', transactionIndex: '0x1', timestamp: '0x68cc0000',
      }] } });
    }
    throw new Error('Unexpected external IO');
  });
  const { default: app } = await import('../src/app.js');
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const payment = createPaymentClient('base-sepolia', toClientEvmSigner(account), { baseUrl, recipient: process.env.ADDRESS, timeoutMs: 3000 });
  const path = (n: number) => '/api/watch/address/0x' + n.toString(16).padStart(40, '0');

  const quote = await nativeFetch(baseUrl + path(1));
  assert.equal(quote.status, 402); assert.equal(providerCalls, 0); assert.equal(settleCalls, 0);
  const success = await payment.fetchWithPayment(path(1));
  assert.equal(success.status, 200); assert.ok(success.headers.get('payment-response'));
  const body = await success.json(); assert.equal(body.count, 1); assert.match(body.cursor, /^w2\./);
  assert.equal(settleCalls, 1);
  for (const [n, failure] of ['denied', 'transport'].entries()) {
    mode = failure;
    const res = await payment.fetchWithPayment(path(n + 2));
    assert.equal(res.status, 502); assert.equal((await res.json()).code, 'UPSTREAM_UNAVAILABLE');
    assert.equal(res.headers.get('payment-response'), null); assert.equal(settleCalls, 1);
  }
  const before = verifyCalls;
  const invalid = await payment.fetchWithPayment(path(2) + '?since=' + encodeURIComponent(body.cursor));
  assert.equal(invalid.status, 400); assert.equal(verifyCalls, before); assert.equal(settleCalls, 1);
  assert.doesNotMatch(JSON.stringify(logs), /test-only-ankr-credential|PRIVATE-PROVIDER-DETAIL|rpc\.ankr\.com\/multichain/);
});
