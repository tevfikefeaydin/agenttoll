import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

test('API routing and ingress stay inside the request boundary', { timeout: 15_000 }, async t => {
  process.env.DOTENV_CONFIG_PATH = 'agenttoll-audit-absent.env';
  process.env.ADDRESS = '0x1111111111111111111111111111111111111111';
  process.env.NETWORK = 'base-sepolia';
  process.env.FACILITATOR_URL = 'https://facilitator.audit.invalid';
  process.env.REQUEST_TIMEOUT_MS = '200';
  delete process.env.VERCEL;
  delete process.env.TRUST_PROXY;
  const nativeFetch = globalThis.fetch;
  const logs: Record<string, unknown>[] = [];
  let facilitatorCalls = 0;
  const record = (line: string) => { try { logs.push(JSON.parse(line)); } catch {} };
  t.mock.method(console, 'log', record);
  t.mock.method(console, 'error', record);
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    facilitatorCalls++;
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith('/supported')) return Response.json({
      kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:84532' }], extensions: [], signers: {},
    });
    throw new Error('Unexpected external request');
  });
  const { default: app } = await import('../src/app.js');
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  const alternates = ['//api/gas', '///API/gas', '/%61pi/gas', '/%61%70%69/gas',
    '/api//gas', '/api/gas//', '/api/%67as'];
  await t.test('SDK-only path forms are rejected and logged before facilitator initialization', async () => {
    for (const path of alternates) {
      const response = await nativeFetch(base + path);
      assert.equal(response.status, 400, path);
      assert.equal(response.headers.get('payment-required'), null, path);
      const body = await response.json();
      assert.equal(body.code, 'BAD_REQUEST');
      assert.equal(body.requestId, response.headers.get('x-request-id'));
      const entry = logs.find(row => row.requestId === body.requestId);
      assert.ok(entry, `${path} must have a terminal request record`);
      assert.equal(entry.status, 400);
      assert.equal(entry.route, '/api/gas');
      assert.equal(entry.facilitatorVerifyCalls, 0);
      assert.equal(entry.paymentReason, null);
    }
    assert.equal(facilitatorCalls, 0);
  });

  await t.test('ordinary path parameters, case and one trailing slash still receive quotes', async () => {
    for (const path of ['/api/price/%65th', '/API/gas/', '/api/base/name/alice%2ebase%2eeth']) {
      const response = await nativeFetch(base + path);
      assert.equal(response.status, 402, path);
      assert.ok(response.headers.get('payment-required'));
      await response.arrayBuffer();
    }
  });

  await t.test('alternate prefixes cannot reach payment verification after exhausting the IP bucket', async () => {
    let finalStatus = 0;
    for (let i = 0; i < 600; i++) {
      const response = await nativeFetch(base + '/api/gas');
      finalStatus = response.status;
      await response.arrayBuffer();
    }
    assert.equal(finalStatus, 429);
    const before = facilitatorCalls;
    for (const path of alternates) {
      const response = await nativeFetch(base + path, { headers: { 'payment-signature': 'malformed' } });
      assert.ok([400, 429].includes(response.status), path);
      assert.equal(response.headers.get('payment-required'), null, path);
      await response.arrayBuffer();
    }
    assert.equal(facilitatorCalls, before);
    assert.equal((await nativeFetch(base + '/api/gas')).status, 429);
  });

  async function incompleteBody(method: string): Promise<{ response: string; ms: number }> {
    const started = Date.now();
    return new Promise((resolve, reject) => {
      let response = '';
      const socket = net.connect(port, '127.0.0.1', () => socket.write(
        `${method} /api/health HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 7\r\n\r\n{`,
      ));
      socket.setTimeout(1_500, () => socket.destroy(new Error('Incomplete request body kept the connection open')));
      socket.on('data', bytes => { response += bytes.toString(); });
      socket.once('error', reject);
      socket.once('close', () => resolve({ response, ms: Date.now() - started }));
    });
  }

  await t.test('body-bearing GET and HEAD requests close without waiting for the sender', async () => {
    const before = facilitatorCalls;
    for (const method of ['GET', 'HEAD']) {
      const { response } = await incompleteBody(method);
      assert.match(response, /^HTTP\/1\.1 400 /);
      assert.match(response, /\r\nConnection: close\r\n/i);
      const body = response.split('\r\n\r\n')[1];
      if (method === 'HEAD') assert.equal(body, '');
      else assert.equal(JSON.parse(body).code, 'BAD_REQUEST');
    }
    assert.equal(facilitatorCalls, before);
  });

  await t.test('a stalled JSON parser responds and closes at the total request deadline', async () => {
    const before = facilitatorCalls;
    const { response, ms } = await incompleteBody('POST');
    assert.match(response, /^HTTP\/1\.1 504 /);
    assert.match(response, /\r\nConnection: close\r\n/i);
    assert.ok(ms >= 150 && ms < 1_500, `deadline response took ${ms} ms`);
    const body = JSON.parse(response.split('\r\n\r\n')[1]);
    assert.equal(body.code, 'REQUEST_TIMEOUT');
    assert.ok(logs.some(row => row.requestId === body.requestId && row.status === 504 && row.terminal === 'finish'));
    assert.equal(facilitatorCalls, before);
  });
});
