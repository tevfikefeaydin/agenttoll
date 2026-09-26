import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDiscovery } from '../web/discovery-model.js';
import { buildResearchDigest } from '../web/research-digest.js';
import { createResearchReminder } from '../web/research-reminder.js';
import { emptyResearchStore, addWatch, saveReport } from '../web/research-store.js';

const token = '0x' + 'a'.repeat(40);
const at = '2026-09-26T10:00:00.000Z';
const later = '2026-09-27T10:00:00.000Z';
const pool = { name: '<img src=x onerror=alert(1)>\nPOOL', pool: '0x' + 'b'.repeat(40), token, createdAt: at, priceUsd: 1, volume24hUsd: 20, liquidityUsd: 10000 };
const radar = () => ({ chain: 'base', at, source: 'geckoterminal-new-pools', count: 1, minLiquidityUsd: 10000, pools: [pool] });
const report = (date: string | null = at) => ({ chain: 'base', token, at: date, sources: ['goplus'], checks: [{ id: 'honeypot', status: 'pass', complete: true, detail: 'Checked', sources: ['goplus'], missing: [] }] });

test('discovery never substitutes a pool address for absent or malformed token attribution', () => {
  for (const value of [null, undefined, 'bad', '0x' + '0'.repeat(40)]) {
    const result = parseDiscovery({ ...radar(), pools: [{ ...pool, token: value }] });
    assert.equal(result.pools[0].token, null);
    assert.equal(result.partial, true);
  }
  assert.equal(parseDiscovery(radar()).pools[0].token, token);
});
test('discovery rejects wrong chain and malformed list, keeps empty result usable', () => {
  assert.throws(() => parseDiscovery({ ...radar(), chain: 'ethereum' }));
  assert.throws(() => parseDiscovery({ ...radar(), pools: {} }));
  assert.equal(parseDiscovery({ ...radar(), count: 0, pools: [] }).pools.length, 0);
});
test('discovery dates and numbers remain unknown, bounded labels are plain text and coverage is partial', () => {
  const result = parseDiscovery({ ...radar(), at: '2026-02-30T10:00:00Z', pools: [{ ...pool, priceUsd: Infinity, volume24hUsd: -1, liquidityUsd: '100', createdAt: 'yesterday' }, null] });
  assert.equal(result.at, null);
  assert.equal(result.pools[0].createdAt, null);
  assert.equal(result.pools[0].priceUsd, null);
  assert.equal(result.pools[0].volume24hUsd, null);
  assert.equal(result.pools[0].liquidityUsd, null);
  assert.equal(result.pools[0].name.includes('\n'), false);
  assert.equal(result.partial, true);
  assert.ok(result.notes.length);
});
test('digest excludes shared/example snapshots and identifies missing dates', () => {
  let store = addWatch(emptyResearchStore(), token, at);
  store = saveReport(store, report(), 'example', at);
  store = saveReport(store, report(later), 'shared', later);
  assert.equal(buildResearchDigest(store)[0].state, 'no-inspections');
  store = saveReport(store, report(null), 'inspection', later);
  assert.equal(buildResearchDigest(store)[0].state, 'missing-date');
});
test('digest prioritizes evidence loss and new risk using two dated inspections', () => {
  let store = addWatch(emptyResearchStore(), token, at);
  store = saveReport(store, report(), 'inspection', at);
  store = saveReport(store, { ...report(later), checks: [] }, 'inspection', later);
  const digest = buildResearchDigest(store)[0];
  assert.equal(digest.state, 'changed');
  assert.equal(digest.evidenceLost, true);
  assert.equal(digest.beforeAt, at);
  assert.equal(digest.afterAt, later);
});
test('digest does not treat cached repeats or same-time conflicting snapshots as fresh evidence', () => {
  let store = addWatch(emptyResearchStore(), token, at);
  store = saveReport(store, report(), 'inspection', at);
  store = saveReport(store, report(), 'inspection', later);
  assert.equal(buildResearchDigest(store)[0].state, 'one-observation');
  store = saveReport(store, { ...report(), checks: [] }, 'inspection', later);
  store = saveReport(store, report(later), 'inspection', later);
  assert.equal(buildResearchDigest(store)[0].state, 'conflict');
  assert.equal(buildResearchDigest(store)[0].changes.length, 0);
});
test('digest distinguishes unchanged dated observations and never uses other tokens', () => {
  let store = addWatch(emptyResearchStore(), token, at);
  store = saveReport(store, report(), 'inspection', at);
  store = saveReport(store, { ...report(later), token: '0x' + 'c'.repeat(40) }, 'inspection', later);
  assert.equal(buildResearchDigest(store)[0].state, 'one-observation');
  store = saveReport(store, report(later), 'inspection', later);
  assert.equal(buildResearchDigest(store)[0].state, 'unchanged');
});
test('calendar reminder is a local all-day event without addresses, automatic alarms or network jobs', () => {
  const ics = createResearchReminder('2026-12-31', at);
  assert.match(ics, /DTSTART;VALUE=DATE:20261231\r\nDTEND;VALUE=DATE:20270101/);
  assert.match(ics, /SUMMARY:Revisit saved token research/);
  assert.doesNotMatch(ics, /VALARM|ATTENDEE|ORGANIZER|RRULE|0x|wallet|PAYMENT/i);
  for (const date of ['2026-02-30', '2026-09-27\r\nATTENDEE:evil', 'bad']) assert.throws(() => createResearchReminder(date, at));
});

test('digest flags loss of partial provider evidence even with unchanged checks', () => {
 for (const sourceStatus of [{ goplus: { status: 'unavailable' } }, {}]) {
  let store = addWatch(emptyResearchStore(), token, at);
  store = saveReport(store, { ...report(), sourceStatus: { goplus: { status: 'partial' } } }, 'inspection', at);
  store = saveReport(store, { ...report(later), sourceStatus }, 'inspection', later);
  assert.equal(buildResearchDigest(store)[0].evidenceLost, true);
  assert.equal(buildResearchDigest(store)[0].state, 'changed');
 }
});
