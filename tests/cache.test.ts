import test from 'node:test';
import assert from 'node:assert/strict';
import { cached, fetchWithTimeout } from '../src/services/cache.js';

test('concurrent readers share one pending upstream load', async () => {
  let loads = 0;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { release = resolve; });
  const calls = Array.from({ length: 10 }, () => cached('concurrent-test', 1000, async () => {
    loads++;
    await ready;
    return { price: 42 };
  }));
  release();
  const values = await Promise.all(calls);
  assert.equal(loads, 1);
  assert.ok(values.every((value) => value.price === 42));
});

test('failed cache loads can be retried', async () => {
  await assert.rejects(cached('retry-test', 1000, async () => { throw new Error('outage'); }), /outage/);
  assert.equal(await cached('retry-test', 1000, async () => 7), 7);
});

test('upstream fetch preserves caller cancellation', async (t) => {
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    init.signal?.throwIfAborted();
    return Response.json({ ok: true });
  });
  const controller = new AbortController();
  controller.abort(new Error('caller cancelled'));
  await assert.rejects(fetchWithTimeout('https://audit.invalid', { signal: controller.signal }), /caller cancelled/);
});


test('aborted loads cannot cache a degraded fallback as a success', async () => {
  const { requestContext } = await import('../src/request-context.js');
  const controller = new AbortController();
  await requestContext.run({ requestId: 'cancel-cache', signal: controller.signal, upstreamCalls: 0, cacheHits: 0, cacheMisses: 0, coalescedLoads: 0 }, async () => {
    await assert.rejects(cached('cancelled-cache-test', 60_000, async () => {
      controller.abort(new DOMException('expired', 'TimeoutError'));
      return [];
    }), { name: 'TimeoutError' });
  });
  assert.deepEqual(await cached('cancelled-cache-test', 60_000, async () => [42]), [42]);
});

test('one cancelled reader cannot cancel an independent reader of the same key', async (t) => {
  const { requestContext } = await import('../src/request-context.js');
  const first = new AbortController();
  const second = new AbortController();
  let calls = 0;
  let started!: () => void;
  const active = new Promise<void>(resolve => { started = resolve; });
  t.mock.method(globalThis, 'fetch', async (_input: unknown, init: RequestInit) => {
    if (++calls > 1) return Response.json({ value: 42 });
    started();
    return new Promise<Response>((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true }));
  });
  const read = (signal: AbortSignal) => requestContext.run({ requestId: 'reader', signal, upstreamCalls: 0, cacheHits: 0, cacheMisses: 0, coalescedLoads: 0 }, () =>
    cached('independent-cancellation', 10_000, async () => (await fetchWithTimeout('https://audit.invalid')).json()));
  const a = read(first.signal);
  const b = read(second.signal);
  const aRejected = assert.rejects(a, /first cancelled/);
  await active;
  first.abort(new Error('first cancelled'));
  await aRejected;
  assert.deepEqual(await b, { value: 42 });
  assert.equal(second.signal.aborted, false);
});
