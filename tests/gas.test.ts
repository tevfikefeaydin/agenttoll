import test from 'node:test';
import assert from 'node:assert/strict';
import { getGas } from '../src/services/gas.js';

test('concurrent gas requests share one short-lived chain observation', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    calls++;
    const request = JSON.parse(String(init.body));
    return Response.json({ result: request.method === 'eth_gasPrice' ? '0x3b9aca00' : '0x64' });
  });
  const values = await Promise.all(Array.from({ length: 10 }, () => getGas()));
  assert.equal(calls, 2);
  assert.equal(values[0].gasPriceGwei, 1);
  assert.equal(values[0].latestBlock, 100);
  assert.equal(new Set(values.map(value => value.at)).size, 1);
});
