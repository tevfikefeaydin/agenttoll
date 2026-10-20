import test from 'node:test';
import assert from 'node:assert/strict';

test('paused endpoints stop unsigned and signed requests before any provider or payment work', async (t) => {
  process.env.DOTENV_CONFIG_PATH = 'agenttoll-test-absent.env';
  process.env.ADDRESS = '0x1111111111111111111111111111111111111111';
  process.env.NETWORK = 'base-sepolia';
  process.env.FACILITATOR_URL = 'https://facilitator.test.invalid';
  process.env.PAUSED_ENDPOINTS = '/api/watch/address/{address}';
  delete process.env.VERCEL;
  delete process.env.TRUST_PROXY;
  const nativeFetch = globalThis.fetch;
  let providerCalls = 0;
  const errors: Record<string, unknown>[] = [];
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', (line: string) => { errors.push(JSON.parse(line)); });
  t.mock.method(globalThis, 'fetch', async () => {
    providerCalls++;
    return Response.json({ kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:84532' }], extensions: [], signers: {} });
  });
  const { default: app } = await import('../src/app.js');
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const paused = '/api/watch/address/0x2222222222222222222222222222222222222222';
  const headerCases: Record<string, string>[] = [{}, { 'payment-signature': 'untrusted-signature' }, { 'x-payment': 'legacy-signature' }];
  for (const method of ['GET', 'HEAD']) {
    for (const headers of headerCases) {
      const response = await nativeFetch(url + paused, { method, headers });
      assert.equal(response.status, 503);
      assert.equal(response.headers.get('retry-after'), '3600');
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('payment-required'), null);
      assert.equal(response.headers.get('payment-response'), null);
      if (method === 'GET') {
        const body = await response.json();
        assert.equal(body.code, 'ENDPOINT_PAUSED');
        assert.doesNotMatch(JSON.stringify(body), /Blockscout|apikey|untrusted-signature|22222222/);
      } else assert.equal(await response.text(), '');
    }
  }
  assert.equal(providerCalls, 0);
  assert.equal(errors.length, 6);
  assert.ok(errors.every(record => record.errorCode === 'ENDPOINT_PAUSED' && record.facilitatorVerifyCalls === 0 && record.facilitatorSettleCalls === 0 && record.upstreamCalls === 0));
  const catalog = await (await nativeFetch(url + '/api/catalog')).json();
  assert.equal(catalog.endpoints.find((e: { path: string }) => e.path === '/api/watch/address/{address}').available, false);
  assert.equal(catalog.endpoints.find((e: { path: string }) => e.path === '/api/gas').available, true);
  const discovery = await (await nativeFetch(url + '/.well-known/x402')).json();
  assert.ok(discovery.resources.length > 0);
  assert.ok(!discovery.resources.some((e: { resource: string }) => e.resource.endsWith('/api/watch/address/{address}')));
  const card = await (await nativeFetch(url + '/.well-known/agent-card.json')).json();
  assert.ok(!card.skills.some((e: { id: string }) => e.id === '/api/watch/address/{address}'));
  assert.equal((await nativeFetch(url + '/api/health')).status, 200);
  assert.equal(providerCalls, 0);
  const gas = await nativeFetch(url + '/api/gas');
  assert.equal(gas.status, 402);
  assert.ok(gas.headers.get('payment-required'));
});
