import test from 'node:test';
import assert from 'node:assert/strict';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { toClientEvmSigner } from '@x402/evm';
import { createPaymentClient } from '../src/payment-policy.js';

test('real middleware payment lifecycle remains bounded and sanitizes facilitator errors', async (t) => {
  process.env.DOTENV_CONFIG_PATH = 'agenttoll-audit-absent.env';
  process.env.ADDRESS = '0x1111111111111111111111111111111111111111';
  process.env.NETWORK = 'base-sepolia';
  process.env.FACILITATOR_URL = 'https://facilitator.audit.invalid';
  process.env.REQUEST_TIMEOUT_MS = '200';
  delete process.env.VERCEL;
  const account = privateKeyToAccount(generatePrivateKey());
  const nativeFetch = globalThis.fetch;
  let mode = 'initialization';
  let settleCalls = 0;
  let releaseSupported!: () => void;
  const supported = { kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:84532' }], extensions: [], signers: {} };
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('http://127.0.0.1:')) return nativeFetch(input, init);
    if (url.endsWith('/supported')) {
      if (mode === 'initialization') return new Promise<Response>(resolve => { releaseSupported = () => resolve(Response.json(supported)); });
      return Response.json(supported);
    }
    if (url.endsWith('/verify')) {
      if (mode === 'declined-verify') return Response.json({ isValid: false, invalidReason: 'invalid_exact_evm_payload_signature' }, { status: 400 });
      if (mode === 'invalid-verify') return Response.json({ diagnostic: 'PRIVATE-UPSTREAM-DIAGNOSTIC' });
      if (mode === 'deadline') await new Promise(resolve => setTimeout(resolve, 125));
      return Response.json({ isValid: true, payer: account.address });
    }
    if (url.endsWith('/settle')) {
      settleCalls++;
      if (mode === 'declined-settle') return Response.json({ success: false, errorReason: 'insufficient_funds', transaction: '', network: 'eip155:84532', payer: account.address }, { status: 400 });
      if (mode === 'invalid-settle') return Response.json({ diagnostic: 'PRIVATE-UPSTREAM-DIAGNOSTIC' });
      if (mode === 'deadline') await new Promise(resolve => setTimeout(resolve, 125));
      return Response.json({ success: true, transaction: '0x' + 'ab'.repeat(32), network: 'eip155:84532', payer: account.address });
    }
    if (url.includes('base.org')) {
      const body = JSON.parse(String(init?.body));
      return Response.json({ jsonrpc: '2.0', id: body.id, result: body.method === 'eth_gasPrice' ? '0x3b9aca00' : '0x64' });
    }
    throw new Error('Unexpected external IO');
  });
  const { default: app } = await import('../src/app.js');
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => { releaseSupported?.(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const payment = createPaymentClient('base-sepolia', toClientEvmSigner(account), { baseUrl, recipient: process.env.ADDRESS, timeoutMs: 3000 });

  await t.test('initialization cannot hold the request beyond its total deadline', async () => {
    // The facilitator mock deliberately ignores its own timeout signal.
    const res = await nativeFetch(baseUrl + '/api/gas', { signal: AbortSignal.timeout(1000) });
    // Initialization starts at module load, so its own deadline may have
    // expired before this request starts (502) or during the request (504).
    assert.ok([502, 504].includes(res.status));
    assert.ok(['UPSTREAM_UNAVAILABLE', 'REQUEST_TIMEOUT'].includes((await res.json()).code));
  });
  releaseSupported(); mode = 'healthy';
  await t.test('normal payment returns data, freshness metadata and a receipt', async () => {
    const res = await payment.fetchWithPayment('/api/gas');
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('payment-response'));
    const body = await res.json();
    assert.equal(body.latestBlock, 100);
    assert.equal(body.meta.requestId, res.headers.get('x-request-id'));
    assert.equal(body.meta.dataNetwork, 'base');
    assert.equal(body.meta.paymentNetwork, 'base-sepolia');
  });
  await t.test('invalid handler input cannot reach settlement', async () => {
    const before = settleCalls;
    const res = await payment.fetchWithPayment('/api/gas?gasLimit=banana');
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, 'BAD_REQUEST');
    assert.equal(settleCalls, before);
  });
  for (const stage of ['verify', 'settle']) await t.test(`malformed facilitator ${stage} output is sanitized and structured`, async () => {
    mode = `invalid-${stage}`;
    const res = await payment.fetchWithPayment('/api/gas');
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.code, 'UPSTREAM_UNAVAILABLE');
    assert.equal(body.requestId, res.headers.get('x-request-id'));
    assert.doesNotMatch(JSON.stringify(body), /PRIVATE-UPSTREAM-DIAGNOSTIC/);
  });
  for (const stage of ['verify', 'settle']) await t.test(`recognized facilitator ${stage} decline remains a protocol 402`, async () => {
    mode = `declined-${stage}`;
    const res = await payment.fetchWithPayment('/api/gas');
    assert.equal(res.status, 402);
    const body = await res.json();
    assert.notEqual(body.code, 'UPSTREAM_UNAVAILABLE');
    assert.notEqual(body.retryable, true);
  });
  await t.test('verification plus settlement share one deadline and report ambiguity', async () => {
    mode = 'deadline';
    const res = await payment.fetchWithPayment('/api/gas');
    assert.equal(res.status, 504);
    const body = await res.json();
    assert.equal(body.code, 'REQUEST_TIMEOUT');
    assert.equal(body.retryable, false);
    assert.equal(body.paymentOutcome, 'unknown');
  });
});
