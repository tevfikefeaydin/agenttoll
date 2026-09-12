import test from 'node:test';
import assert from 'node:assert/strict';

test('operations: free routes stay independent and request records preserve payment outcomes', async (t) => {
  process.env.DOTENV_CONFIG_PATH = 'agenttoll-audit-absent.env';
  process.env.ADDRESS = '0x1111111111111111111111111111111111111111';
  process.env.NETWORK = 'base-sepolia';
  process.env.FACILITATOR_URL = 'https://facilitator.audit.invalid';
  process.env.REQUEST_TIMEOUT_MS = '200';
  delete process.env.VERCEL;
  delete process.env.TRUST_PROXY;
  const nativeFetch = globalThis.fetch;
  let supportedCalls = 0;
  let healthy = false;
  const logs: Record<string, unknown>[] = [];
  t.mock.method(console, 'log', (line: string) => { try { logs.push(JSON.parse(line)); } catch {} });
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  t.mock.method(globalThis, 'fetch', async () => {
    supportedCalls++;
    if (!healthy) throw new DOMException('Private provider detail', 'TimeoutError');
    return Response.json({ kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:84532' }], extensions: [], signers: {} });
  });
  const { default: app } = await import('../src/app.js');
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });

  await t.test('health, discovery and catalog never initialize the payment provider', async () => {
    for (const path of ['/api/health', '/api/catalog', '/.well-known/x402', '/.well-known/agent-card.json']) {
      const res = await nativeFetch(baseUrl + path);
      assert.equal(res.status, 200);
      await res.arrayBuffer();
    }
    assert.equal(supportedCalls, 0);
  });
  await t.test('failed initialization reports a deadline and a later request recovers', async () => {
    const failed = await nativeFetch(baseUrl + '/api/gas');
    healthy = true;
    assert.equal(failed.status, 504);
    assert.equal((await failed.json()).code, 'REQUEST_TIMEOUT');
    const recovered = await nativeFetch(baseUrl + '/api/gas');
    assert.equal(recovered.status, 402);
    assert.ok(recovered.headers.get('payment-required'));
    await recovered.arrayBuffer();
  });
  await t.test('HEAD is logged as HEAD, with a canonical endpoint and no address or query', async () => {
    const res = await nativeFetch(baseUrl + '/API/base/token/0x2222222222222222222222222222222222222222/?secret=private', { method: 'HEAD' });
    assert.equal(res.status, 402);
    const entry = logs.find(e => e.requestId === res.headers.get('x-request-id'))!;
    assert.ok(entry);
    assert.equal(entry.method, 'HEAD');
    assert.equal(entry.route, '/api/base/token/{address}');
    assert.equal(entry.path, '/api/base/token/{address}');
    assert.equal(entry.paymentStage, 'quote');
    assert.doesNotMatch(JSON.stringify(entry), /222222222|secret|private/);
  });
  await t.test('a signed malformed payment is a rejection, never an unsigned quote', async () => {
    const res = await nativeFetch(baseUrl + '/api/gas', { headers: { 'payment-signature': 'invalid' } });
    assert.equal(res.status, 402);
    await res.arrayBuffer();
    const entry = logs.find(e => e.requestId === res.headers.get('x-request-id'))!;
    assert.equal(entry.paymentStage, 'rejected');
    assert.equal(entry.paymentSubmitted, true);
  });
});
