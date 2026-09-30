import test from 'node:test';
import assert from 'node:assert/strict';
import { getFreshPools } from '../src/services/fresh.js';
import { BadRequestError } from '../src/services/errors.js';

test('unknown fundedOnly values fail validation before spending upstream quota', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('upstream should not be called'); });
  await assert.rejects(getFreshPools('1', '1', 'banana'), BadRequestError);
  await assert.rejects(getFreshPools('1', '1', '0'), BadRequestError);
});
