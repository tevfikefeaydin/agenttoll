import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { activityProvider, ankrActivityPage } from '../src/services/activity-provider.js';
import { getAddressActivity, validateActivityCursor } from '../src/services/watch.js';

const key = 'test-only-ankr-credential';
const address = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const time = Date.parse('2026-10-01T10:00:00Z');
const tx = (n: number, a: string, at = time) => ({ blockchain: 'base', hash: hash(n), from: a,
  to: address(9999), value: '0x0', input: '0x095ea7b3', status: '0x1', blockNumber: '0x64',
  transactionIndex: `0x${n.toString(16)}`, timestamp: `0x${Math.floor(at / 1000).toString(16)}` });
const reply = (transactions: unknown[], nextPageToken: string | null = null) => Response.json({ jsonrpc: '2.0', id: 1, result: { transactions, nextPageToken } });
const decode = (cursor: string) => JSON.parse(inflateRawSync(Buffer.from(cursor.slice(3), 'base64url')).toString());
const encode = (obj: object, version = 2) => `w${version}.${deflateRawSync(JSON.stringify(obj)).toString('base64url')}`;
const provider = process.env.ADDRESS_ACTIVITY_PROVIDER, previousKey = process.env.ANKR_API_KEY;
beforeEach(() => {
  process.env.ADDRESS_ACTIVITY_PROVIDER = 'ankr'; process.env.ANKR_API_KEY = key;
});
afterEach(() => {
  if (provider === undefined) delete process.env.ADDRESS_ACTIVITY_PROVIDER; else process.env.ADDRESS_ACTIVITY_PROVIDER = provider;
  if (previousKey === undefined) delete process.env.ANKR_API_KEY; else process.env.ANKR_API_KEY = previousKey;
});

test('activity provider must be explicitly selected and configured', () => {
  assert.equal(activityProvider({}), 'blockscout');
  assert.throws(() => activityProvider({ ADDRESS_ACTIVITY_PROVIDER: 'typo' }), /ADDRESS_ACTIVITY_PROVIDER/);
  for (const bad of [undefined, '', 'https://example.invalid/key', 'key\nsecret']) {
    assert.throws(() => activityProvider({ ADDRESS_ACTIVITY_PROVIDER: 'ankr', ANKR_API_KEY: bad }), /ANKR_API_KEY/);
  }
  assert.equal(activityProvider({ ADDRESS_ACTIVITY_PROVIDER: 'ankr', ANKR_API_KEY: key }), 'ankr');
});

test('Ankr drains 101 transactions across pages with a fixed window and no lost boundary', async t => {
  const a = address(101); let now = time + 60000;
  t.mock.method(Date, 'now', () => now);
  const requests: Record<string, unknown>[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(url), `https://rpc.ankr.com/multichain/${key}`);
    assert.equal(init?.redirect, 'error');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.method, 'ankr_getTransactionsByAddress');
    const p = body.params; requests.push(p);
    assert.equal(p.address, a); assert.deepEqual(p.blockchain, ['base']);
    assert.equal(p.pageSize, 50); assert.equal(p.includeLogs, false); assert.equal(p.descOrder, true);
    const top = p.pageToken === 'page-two' ? 51 : p.pageToken === 'page-three' ? 1 : 101;
    return reply(Array.from({ length: Math.min(top, 50) }, (_, i) => tx(top - i, a)), top > 51 ? 'page-two' : top > 1 ? 'page-three' : null);
  });
  let cursor: string | undefined; const all: string[] = [];
  for (let page = 0; page < 3; page++) {
    const result = await getAddressActivity(a, cursor); cursor = result.cursor;
    assert.equal(result.hasMore, page < 2); assert.equal(result.coverage.complete, page === 2);
    assert.match(cursor, /^w2\./); assert.ok(cursor.length <= 8000);
    all.push(...result.events.map(e => e.hash)); now += 30000;
  }
  assert.equal(new Set(all).size, 101);
  assert.equal(new Set(requests.map(p => p.toTimestamp)).size, 1);
  assert.ok(requests.every(p => p.fromTimestamp === 0));
  assert.equal(decode(cursor!).next, null); assert.equal(decode(cursor!).until, null);
});

test('Ankr includes zero-value, failed, incoming and contract-creation transactions', async t => {
  const a = address(102);
  t.mock.method(globalThis, 'fetch', async () => reply([
    tx(4, a), { ...tx(3, a), status: '0x0' }, { ...tx(2, address(999)), to: a, value: '1000000000000000000' },
    { ...tx(1, a), to: null, input: '0x' },
  ]));
  const result = await getAddressActivity(a);
  assert.equal(result.count, 4);
  assert.deepEqual(result.events.map(e => e.direction), ['out', 'out', 'in', 'out']);
  assert.equal(result.events[0].method, '0x095ea7b3'); assert.equal(result.events[0].ethValue, 0);
  assert.equal(result.events[2].ethValue, 1); assert.equal(result.events[3].counterparty, null);
});

test('Ankr polling overlap catches delayed same-time records and deduplicates repeats', async t => {
  const a = address(103); let now = time + 60000, round = 0;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async () => reply(round++ === 0 ? [tx(5, a)] : [tx(6, a), tx(5, a), tx(4, a, time - 30000)]));
  const first = await getAddressActivity(a); now += 21000;
  const second = await getAddressActivity(a, first.cursor); now += 21000;
  const third = await getAddressActivity(a, second.cursor);
  assert.deepEqual(second.events.map(e => e.hash), [hash(6), hash(4)]); assert.equal(third.count, 0);
});

test('legacy backfill migrates by replaying its original window, preserving seen hashes', async t => {
  const a = address(104), floor = time - 86400000;
  const old = encode({ v: 1, address: a, floor, watermark: time, next: { block_number: 100, index: 3, items_count: 50 }, seen: [[hash(5), time]], replayPossible: false }, 1);
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const p = JSON.parse(String(init?.body)).params;
    assert.equal(p.fromTimestamp, floor / 1000); assert.equal(p.pageToken, undefined);
    return reply([tx(5, a), tx(4, a), tx(1, a, floor + 5000)]);
  });
  const result = await getAddressActivity(a, old);
  assert.deepEqual(result.events.map(e => e.hash), [hash(4), hash(1)]);
  assert.equal(result.coverage.replayPossible, true); assert.match(result.cursor, /^w2\./);
});

test('Ankr cursors reject wrong addresses/providers and malformed continuation before IO', async t => {
  const a = address(105); let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return reply([tx(3, a)], 'next'); });
  const first = await getAddressActivity(a), state = decode(first.cursor);
  for (const altered of [{ ...state, address: address(106) }, { ...state, provider: 'other' },
    { ...state, next: 'x'.repeat(2049) }, { ...state, next: {} }, { ...state, until: -1 }, { ...state, boundary: null }]) {
    assert.throws(() => validateActivityCursor(a, encode(altered)), /cursor/);
  }
  assert.throws(() => validateActivityCursor(a, 'w2.' + 'A'.repeat(8000)), /cursor/);
  process.env.ADDRESS_ACTIVITY_PROVIDER = 'blockscout';
  assert.throws(() => validateActivityCursor(a, first.cursor), /cursor/);
  assert.equal(calls, 1);
});

test('Ankr rejects repeated tokens and non-advancing chain positions', async t => {
  for (const [i, sameToken] of [true, false].entries()) {
    const a = address(110 + i); let round = 0;
    t.mock.method(globalThis, 'fetch', async () => reply([tx(2, a)], round++ === 0 || sameToken ? 'next' : 'different'));
    const first = await getAddressActivity(a);
    await assert.rejects(getAddressActivity(a, first.cursor), /did not advance/);
  }
});

test('Ankr rejects malformed, unrelated and wrong-chain data instead of reporting empty activity', async t => {
  const a = address(120);
  for (const patch of [{ blockchain: 'eth' }, { hash: 'bad' }, { value: '-1' }, { value: '0x' },
    { timestamp: 'no-date' }, { timestamp: '0xffffffffffffffff' }, { from: address(998) }, { transactionIndex: '0x20000000000000' }]) {
    t.mock.method(globalThis, 'fetch', async () => reply([{ ...tx(1, a), ...patch }]));
    await assert.rejects(ankrActivityPage(a, null, 0, time + 10000), /Invalid activity provider response/);
  }
  for (const response of [() => reply([], 'next'), () => reply(Array.from({ length: 51 }, () => tx(1, a))),
    () => Response.json({ jsonrpc: '2.0', id: 1, result: { transactions: Array.from({ length: 50 }, () => tx(1, a)) } }),
    () => Response.json({ jsonrpc: '2.0', id: 1, result: { transactions: [], nextPageToken: null, syncStatus: { status: 'syncing' } } }),
    () => reply([tx(1, a, time + 60000)]),
    () => Response.json({ jsonrpc: '2.0', id: 1, result: {} })]) {
    t.mock.method(globalThis, 'fetch', response);
    await assert.rejects(ankrActivityPage(a, null, 0, time + 10000));
  }
});

test('Ankr retries a short 429 once, but does not retry denial or long throttling', async t => {
  const a = address(121); let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => ++calls === 1 ? new Response(key, { status: 429, headers: { 'retry-after': '0' } }) : reply([]));
  await ankrActivityPage(a, null, 0, time); assert.equal(calls, 2);
  for (const status of [401, 403, 429]) {
    calls = 0;
    t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response(key, { status, headers: { 'retry-after': '60' } }); });
    await assert.rejects(ankrActivityPage(a, null, 0, time), new RegExp(`HTTP ${status}`)); assert.equal(calls, 1);
  }
});

test('Ankr sanitizes provider, transport and parser errors and limits body size', async t => {
  const a = address(122);
  for (const fetcher of [async () => { throw new Error(`failed https://rpc.ankr.com/multichain/${key}`); },
    async () => Response.json({ jsonrpc: '2.0', id: 1, error: { message: key } }),
    async () => new Response(key), async () => new Response('x'.repeat(1_048_577))]) {
    t.mock.method(globalThis, 'fetch', fetcher);
    await assert.rejects(ankrActivityPage(a, null, 0, time), (error: Error) => {
      assert.doesNotMatch(error.stack ?? '', /test-only-ankr-credential|rpc\.ankr\.com|https:/); return true;
    });
  }
});

test('worst-case cursor entropy remains bounded and signals reduced deduplication', async t => {
  const a = address(123); let round = 0;
  const randomTx = (n: number) => ({ ...tx(n, a), hash: `0x${randomBytes(32).toString('hex')}` });
  t.mock.method(globalThis, 'fetch', async () => reply(Array.from({ length: 50 }, (_, i) => randomTx(200 - round * 50 - i)), randomBytes(1536).toString('base64')));
  const first = await getAddressActivity(a); round++;
  const second = await getAddressActivity(a, first.cursor);
  assert.ok(second.cursor.length <= 8000); validateActivityCursor(a, second.cursor);
  assert.ok(decode(second.cursor).seen.length <= 100);
  if (decode(second.cursor).seen.length < 100) assert.equal(second.coverage.replayPossible, true);
});
