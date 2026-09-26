import test from 'node:test';
import assert from 'node:assert/strict';
import { ENDPOINT_MANIFEST } from '../src/endpoint-manifest.js';
import { ENDPOINTS } from '../src/endpoints.js';

test('API integration: payment headers, discovery network, errors and normalized limits', async (t) => {
  process.env.DOTENV_CONFIG_PATH = 'agenttoll-audit-absent.env';
  process.env.NETWORK = 'base-sepolia';
  process.env.ADDRESS = '0x1111111111111111111111111111111111111111';
  process.env.FACILITATOR_URL = 'https://audit.invalid';
  delete process.env.VERCEL;
  delete process.env.TRUST_PROXY;
  const nativeFetch = globalThis.fetch;
  let rpcReady = false;
  let externalCalls = 0;
  t.mock.method(console, 'log', () => {});
  t.mock.method(globalThis, 'fetch', async (input: unknown) => {
    externalCalls++;
    if (String(input).endsWith('/supported')) return Response.json({
      kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:84532' }], extensions: [], signers: {},
    });
    if (rpcReady && String(input).includes('mainnet.base.org')) return Response.json({ result: '0x64' });
    throw new Error('Unexpected upstream in API test');
  });
  const { default: app } = await import('../src/app.js');
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });

  await t.test('invalid inputs fail before any payment initialization or provider call', async () => {
    const before = externalCalls;
    for (const route of ['/api/base/safety/not-an-address', '/api/base/token/bad', '/api/base/address/bad',
      '/api/base/portfolio/bad', '/api/gas?gasLimit=bad', '/api/trending?limit=26',
      '/api/base/trending?limit=21', '/api/base/radar?minLiquidity=bad&limit=-1',
      '/api/base/scout?pools=5', '/api/base/fresh?fundedOnly=maybe', '/api/base/fresh?minutes=61',
      '/api/base/radar/history?date=2026-02-30', '/api/base/scorecard?days=31', '/api/feargreed?days=31',
      '/api/brief?symbols=bad!', '/api/try/premium?asset=invalid', '/api/try/spread?asset=eth',
      '/api/base/name/bad%21name', '/api/watch/address/bad', '/api/watch/radar?since=bad',
      '/api/watch/price/eth', '/api/watch/price/eth?ref=0', '/api/watch/price/eth?ref=1&pct=-1',
      '/api/price/bad%21ticker', '/API/gas/?gasLimit=bad', '/api/gas?gasLimit=21000&gasLimit=50000',
      '/api/gas?gasLimit[x]=21000', '/api/gas?' + '&'.repeat(1000) + 'gasLimit=bad',
      '/api/gas?gasLimit=21000' + '&'.repeat(1000) + 'gasLimit=bad']) {
      const response = await nativeFetch(base + route);
      assert.equal(response.status, 400, route);
      assert.equal(response.headers.get('payment-required'), null, route);
      const body = await response.json();
      assert.equal(body.code, 'BAD_REQUEST', route);
      assert.equal(body.retryable, false);
      assert.equal(body.requestId, response.headers.get('x-request-id'));
    }
    assert.equal(externalCalls, before);
  });
  await t.test('unknown API routes return structured JSON without echoing caller data', async () => {
    for (const route of ['/api/does-not-exist', '/API/does-not-exist', '/api']) {
      const response = await nativeFetch(base + route);
      assert.equal(response.status, 404);
      assert.match(response.headers.get('content-type') ?? '', /application\/json/);
      const body = await response.json();
      assert.equal(body.code, 'NOT_FOUND');
      assert.equal(body.requestId, response.headers.get('x-request-id'));
      assert.equal(body.retryable, false);
    }
  });

  await t.test('cross-origin v2 signatures and receipt headers are allowed', async () => {
    const res = await nativeFetch(base + '/api/gas', { method: 'OPTIONS', headers: {
      Origin: 'https://client.example', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'payment-signature',
    } });
    assert.equal(res.status, 204);
    assert.match(res.headers.get('access-control-allow-headers') ?? '', /payment-signature/i);
    assert.match(res.headers.get('access-control-expose-headers') ?? '', /payment-required/i);
    assert.match(res.headers.get('access-control-expose-headers') ?? '', /payment-response/i);
  });
  await t.test('agent card uses the actual configured payment network', async () => {
    const body = await (await nativeFetch(base + '/.well-known/agent-card.json')).json();
    assert.equal(body.interfaces.http.payment.network, 'eip155:84532');
  });
  await t.test('paid URL variants remain behind the payment gate', async () => {
    for (const path of ['/api/gas', '/api/gas/', '/API/gas']) {
      const res = await nativeFetch(base + path);
      assert.equal(res.status, 402);
      assert.ok(res.headers.get('payment-required'));
      await res.arrayBuffer();
    }
  });
  await t.test('all registered endpoint quotes agree with catalog, network and client fee caps', async () => {
    const catalog = await (await nativeFetch(base + '/api/catalog')).json();
    assert.equal(catalog.endpoints.filter((entry: { price: string }) => entry.price !== 'free').length, ENDPOINT_MANIFEST.length);
    for (const endpoint of ENDPOINT_MANIFEST) {
      const definition = ENDPOINTS.find(e => e.path === endpoint.path)!;
      const params = definition.discovery.pathParams ?? {};
      const query = new URLSearchParams((definition.discovery.inputSchema?.required ?? []).map(key => [key, String(definition.discovery.input?.[key])]));
      const path = endpoint.path.replace(/\{([^}]+)\}/g, (_, key) => String(params[key])) + (query.size ? '?' + query : '');
      const response = await nativeFetch(base + path);
      assert.equal(response.status, 402, path);
      const quote = JSON.parse(Buffer.from(response.headers.get('payment-required')!, 'base64').toString());
      assert.equal(quote.accepts[0].amount, endpoint.amount, path);
      assert.equal(quote.accepts[0].network, 'eip155:84532', path);
      assert.equal(catalog.endpoints.find((entry: { path: string }) => entry.path === endpoint.path).price, endpoint.price);
      assert.match(response.headers.get('content-type') ?? '', /application\/json/);
      assert.deepEqual(await response.json(), quote, `${path}: body readers receive the same complete quote as header readers`);
    }
  });
  await t.test('quote bodies preserve the requested resource and query parameters', async () => {
    for (const path of ['/api/price/BTC', '/api/gas?gasLimit=21000', '/api/gas/', '/API/gas']) {
      const response = await nativeFetch(base + path);
      assert.equal(response.status, 402);
      const body = await response.json();
      assert.equal(body.x402Version, 2);
      assert.equal(body.resource.url, base + path);
      assert.equal(body.accepts[0].amount, '1000');
      assert.equal(body.accepts[0].payTo, process.env.ADDRESS);
      assert.ok(body.extensions.bazaar);
      assert.deepEqual(body, JSON.parse(Buffer.from(response.headers.get('payment-required')!, 'base64').toString()));
    }
  });
  await t.test('malformed JSON has a structured error and request identity', async () => {
    const res = await nativeFetch(base + '/api/health', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, 'BAD_REQUEST');
    assert.equal(body.retryable, false);
    assert.equal(body.requestId, res.headers.get('x-request-id'));
    assert.ok(body.requestId);
  });
  await t.test('readiness reports an unavailable data source while liveness stays healthy', async () => {
    t.mock.method(console, 'warn', () => {});
    const res = await nativeFetch(base + '/api/ready');
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.checks.facilitator, true);
    assert.equal(body.checks.baseRpc, false);
    assert.equal(body.code, 'NOT_READY');
    assert.equal((await nativeFetch(base + '/api/health')).status, 200);
  });
  await t.test('readiness becomes healthy after the failed check expires', async (context) => {
    const now = Date.now();
    context.mock.method(Date, 'now', () => now + 16_000);
    rpcReady = true;
    const response = await nativeFetch(base + '/api/ready');
    assert.equal(response.status, 200);
    assert.equal((await response.json()).checks.baseRpc, true);
  });
  await t.test('case, trailing slash and forged forwarded IP cannot bypass free rate limits', async () => {
    for (let i = 0; i < 61; i++) await (await nativeFetch(base + '/api/health')).arrayBuffer();
    for (const path of ['/api/health', '/API/health', '/api/health/']) {
      const res = await nativeFetch(base + path, { headers: { 'X-Forwarded-For': '198.51.100.9' } });
      await res.arrayBuffer();
      assert.equal(res.status, 429, path);
    }
  });
});
