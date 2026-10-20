import test from 'node:test';
import assert from 'node:assert/strict';
import { checkService } from '../src/operations-check.js';
import { ENDPOINTS } from '../src/endpoints.js';

test('service check uses only unsigned GETs and reports provider failures without secrets', async (t) => {
  const requests: Request[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    requests.push(req);
    if (req.url.endsWith('/api/health')) return Response.json({ ok: true, network: 'base', dataNetwork: 'base' });
    if (req.url.endsWith('/api/ready')) return Response.json({ ok: false, checks: { facilitator: false, baseRpc: true } }, { status: 503 });
    return Response.json({ diagnostic: 'PRIVATE-PROVIDER-DETAIL' }, { status: 502 });
  });
  const report = await checkService();
  assert.equal(report.ok, false);
  assert.equal(report.checks.length, 24);
  assert.equal(report.checks.find(c => c.path === '/api/health')?.ok, true);
  assert.equal(report.checks.find(c => c.path === '/api/ready')?.ok, false);
  assert.ok(requests.length >= 24);
  for (const req of requests) {
    assert.equal(req.method, 'GET');
    assert.equal(req.headers.has('payment-signature'), false);
    assert.equal(req.headers.has('x-payment'), false);
    assert.equal(req.headers.has('authorization'), false);
  }
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE-PROVIDER-DETAIL/);
  assert.equal(report.budget.canSign, false);
  assert.equal(Number(report.budget.totalUsdc), 0);
});

test('service check distinguishes an intentional pause from a broken paused route', async (t) => {
  for (const code of ['ENDPOINT_PAUSED', 'UPSTREAM_UNAVAILABLE']) {
    await t.test(code, async (t) => {
      const pausedPath = '/api/watch/address/{address}';
      t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.endsWith('/api/catalog')) return Response.json({ network: 'base', endpoints: ENDPOINTS.map(e => ({ path: e.path, price: e.price, available: e.path !== pausedPath })) });
        if (url.includes('/api/watch/address/')) return Response.json({ code }, { status: 503 });
        return Response.json({}, { status: 502 });
      });
      const report = await checkService();
      assert.equal(report.degraded, true);
      const paused = report.checks.find(check => check.path === pausedPath)!;
      assert.equal(paused.ok, code === 'ENDPOINT_PAUSED');
      assert.equal(Boolean(paused.paused), code === 'ENDPOINT_PAUSED');
      assert.equal(report.budget.canSign, false);
    });
  }
});
