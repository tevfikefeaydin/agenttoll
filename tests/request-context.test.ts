import test from 'node:test';
import assert from 'node:assert/strict';
import { requestContext, withSignal } from '../src/request-context.js';
import { fetchWithTimeout } from '../src/services/cache.js';

test('request deadlines stop waiting even for an uncooperative upstream', async () => {
  const controller = new AbortController();
  const pending = withSignal(new Promise(() => {}), controller.signal);
  controller.abort(new DOMException('expired', 'TimeoutError'));
  await assert.rejects(pending, { name: 'TimeoutError' });
});

test('already-aborted contexts cannot start an upstream request', async (t) => {
  const controller = new AbortController();
  controller.abort(new DOMException('expired', 'TimeoutError'));
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({}); });
  await requestContext.run({ requestId: 'test', signal: controller.signal, upstreamCalls: 0, cacheHits: 0, cacheMisses: 0, coalescedLoads: 0 }, async () => {
    await assert.rejects(fetchWithTimeout('https://audit.invalid'), { name: 'TimeoutError' });
  });
  assert.equal(calls, 0);
});
