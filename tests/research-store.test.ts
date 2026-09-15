import test from 'node:test';
import assert from 'node:assert/strict';
import { RESEARCH_STORAGE_KEY, emptyResearchStore, addWatch, removeWatch, saveReport, removeReport, clearResearchStore, readResearchStore, writeResearchStore, reconcileResearchStore, type StorageLike } from '../web/research-store.js';

const token = '0x' + 'a'.repeat(40);
const at = '2026-09-15T10:00:00.000Z';
const savedAt = '2026-09-15T11:00:00.000Z';
const address = (n: number) => '0x' + n.toString(16).padStart(40, '0');
const report = (date: unknown = at, contract = token) => ({ chain: 'base', token: contract, at: date, name: 'Example', symbol: 'EX',
  checks: [{ id: 'honeypot', status: 'unknown', complete: false, detail: 'Evidence unavailable.', missing: ['simulation'], conflicts: [], sources: [] }] });
function storage(initial: string | null = null): StorageLike & { raw: string | null } {
  return { raw: initial, getItem(key) { assert.equal(key, RESEARCH_STORAGE_KEY); return this.raw; },
    setItem(key, value) { assert.equal(key, RESEARCH_STORAGE_KEY); this.raw = value; } };
}

test('watchlist normalizes and deduplicates addresses without mutating prior state', () => {
  const original = emptyResearchStore();
  const first = addWatch(original, token.toUpperCase().replace('0X', '0x'), '<b>Example</b>', at);
  const duplicate = addWatch(first, token, 'Changed', savedAt);
  assert.deepEqual(original.watchlist, []);
  assert.equal(duplicate.watchlist.length, 1);
  assert.equal(duplicate.watchlist[0].token, token);
  assert.equal(duplicate.watchlist[0].addedAt, at);
  assert.equal(first.watchlist[0].label, '<b>Example</b>');
  assert.deepEqual(removeWatch(first, token).watchlist, []);
  assert.throws(() => addWatch(first, address(0)));
});

test('watchlist limit keeps existing saved tokens and labels are bounded', () => {
  let state = emptyResearchStore();
  for (let n = 1; n <= 50; n++) state = addWatch(state, address(n), 'N'.repeat(10_000), at);
  assert.equal(state.watchlist.length, 50);
  assert.ok(state.watchlist[0].label!.length <= 200);
  assert.throws(() => addWatch(state, address(51)), /50|full|limit/i);
});

test('saved reports retain provenance and only bounded canonical data', () => {
  const state = saveReport(emptyResearchStore(), { ...report(), signature: 'secret', receipt: { payer: 'secret' } }, 'example', savedAt);
  assert.equal(state.reports.length, 1);
  assert.equal(state.reports[0].savedAt, savedAt);
  assert.equal(state.reports[0].token, token);
  assert.equal(state.reports[0].origin, 'example');
  assert.ok(state.reports[0].id.length > 0);
  assert.equal(JSON.stringify(state).includes('secret'), false);
  assert.deepEqual(removeReport(state, state.reports[0].id).reports, []);
  assert.deepEqual(clearResearchStore(), { version: 1, watchlist: [], reports: [] });
});

test('same-origin cached observations deduplicate independently of request IDs', () => {
  const first = saveReport(emptyResearchStore(), { ...report(), requestId: 'first' }, 'example', savedAt);
  const duplicate = saveReport(first, { ...report(), requestId: 'second' }, 'example', '2026-09-15T12:00:00Z');
  assert.equal(duplicate.reports.length, 1);
  assert.equal(duplicate.reports[0].savedAt, savedAt);
  assert.equal(duplicate.reports[0].origin, 'example');
  assert.equal(duplicate.reports[0].id, first.reports[0].id);
  const fresh = saveReport(duplicate, report('2026-09-15T12:00:00Z'), 'inspection', '2026-09-15T12:01:00Z');
  assert.equal(fresh.reports.length, 2);
});

test('identical example, inspection, and shared observations retain separate provenance after saving and reloading', () => {
  const example = saveReport(emptyResearchStore(), report(), 'example', savedAt);
  const inspection = saveReport(example, report(), 'inspection', '2026-09-15T12:00:00Z');
  assert.deepEqual(inspection.reports.map(entry => entry.origin), ['inspection', 'example']);
  assert.equal(inspection.reports.find(entry => entry.origin === 'example')!.id, example.reports[0].id);
  const shared = saveReport(inspection, report(), 'shared', '2026-09-15T13:00:00Z');
  assert.deepEqual(shared.reports.map(entry => entry.origin), ['shared', 'inspection', 'example']);
  assert.equal(shared.reports.find(entry => entry.origin === 'inspection')!.id, inspection.reports[0].id);
  assert.equal(new Set(shared.reports.map(entry => entry.id)).size, 3);
  const disk = storage();
  assert.equal(writeResearchStore(shared, disk).saved, true);
  const reloaded = readResearchStore(disk);
  assert.deepEqual(reloaded.warnings, []);
  assert.deepEqual(reloaded.store, shared);
  const repeated = saveReport(reloaded.store, report(), 'inspection', '2026-09-15T14:00:00Z');
  assert.equal(repeated.reports.length, 3);
  assert.equal(repeated.reports.find(entry => entry.origin === 'inspection')!.savedAt, '2026-09-15T12:00:00.000Z');
});

test('reloading identical content deduplicates only within its recorded origin', () => {
  const state = saveReport(emptyResearchStore(), report(), 'inspection', savedAt);
  const entry = state.reports[0];
  const disk = storage(JSON.stringify({ ...state, reports: [entry,
    { ...entry, id: 'shared-copy', origin: 'shared' },
    { ...entry, id: 'example-copy', origin: 'example' },
    { ...entry, id: 'inspection-duplicate' }] }));
  const loaded = readResearchStore(disk);
  assert.deepEqual(loaded.store.reports.map(snapshot => snapshot.origin), ['inspection', 'shared', 'example']);
  assert.equal(new Set(loaded.store.reports.map(snapshot => snapshot.id)).size, 3);
  assert.ok(loaded.warnings.length > 0);
});

test('missing-date repeated content deduplicates but unknown dates never become save dates', () => {
  const first = saveReport(emptyResearchStore(), report(null), 'shared', savedAt);
  const second = saveReport(first, report('invalid'), 'shared', '2026-09-15T12:00:00Z');
  assert.equal(second.reports.length, 1);
  assert.equal(second.reports[0].data.at, null);
});

test('invalid supplied save dates are rejected even for duplicate entries', () => {
  const state = addWatch(saveReport(emptyResearchStore(), report(), 'inspection', savedAt), token, 'Example', at);
  assert.throws(() => addWatch(state, token, 'Example', 'yesterday'));
  assert.throws(() => saveReport(state, report(), 'inspection', 'yesterday'));
});

test('history orders by observation time and uses saved time only for undated reports', () => {
  let state = saveReport(emptyResearchStore(), report(at), 'inspection', '2026-09-16T10:00:00Z');
  state = saveReport(state, report('2026-09-15T12:00:00Z'), 'inspection', '2026-09-15T12:00:00Z');
  state = saveReport(state, report(null), 'shared', '2026-09-15T11:00:00Z');
  assert.deepEqual(state.reports.map(r => r.data.at), ['2026-09-15T12:00:00.000Z', null, at]);
});

test('retention keeps ten most recent observations per token even if an old report is imported later', () => {
  let state = emptyResearchStore();
  for (let n = 1; n <= 11; n++) state = saveReport(state, report(`2026-09-${String(n).padStart(2, '0')}T10:00:00Z`), 'inspection', savedAt);
  assert.equal(state.reports.length, 10);
  assert.equal(state.reports[0].data.at, '2026-09-11T10:00:00.000Z');
  assert.equal(state.reports.at(-1)!.data.at, '2026-09-02T10:00:00.000Z');
  const restored = saveReport(state, report('2020-01-01T00:00:00Z'), 'shared', savedAt);
  assert.equal(restored.reports.length, 10);
  assert.equal(restored.reports.some(r => r.data.at!.startsWith('2020')), false);
});

test('global retention keeps at most 100 bounded reports', () => {
  let state = emptyResearchStore();
  for (let n = 1; n <= 102; n++) state = saveReport(state, report(at, address(n)), 'inspection', savedAt);
  assert.equal(state.reports.length, 100);
  assert.ok(JSON.stringify(state).length * 2 <= 2 * 1024 * 1024);
});

test('large reports evict old snapshots to fit the byte budget without truncating current evidence', () => {
  let state = emptyResearchStore();
  const evidence = Array.from({ length: 30 }, (_, i) => `${String(i).padStart(2, '0')}:` + 'e'.repeat(157));
  const ids = ['honeypot', 'taxes', 'verified', 'owner-powers', 'concentration', 'liquidity', 'creator-stake', 'deployer'];
  for (let n = 1; n <= 15; n++) state = saveReport(state, { ...report(at, address(n)),
    checks: ids.map(id => ({ id, status: 'unknown', complete: false, detail: 'D'.repeat(2000), missing: evidence, conflicts: evidence, sources: evidence })) },
  'inspection', `2026-09-${String(n).padStart(2, '0')}T12:00:00Z`);
  assert.ok(state.reports.length > 0 && state.reports.length < 15);
  assert.ok(JSON.stringify(state).length * 2 <= 2 * 1024 * 1024);
  assert.equal(state.reports[0].token, address(15));
  assert.equal(state.reports[0].data.checks[0].missing.length, 30);
  assert.equal(state.reports[0].data.checks[0].detail.length, 2000);
});

test('same-time conflicting snapshots keep distinct selectable IDs and fetch-time-only repeats deduplicate', () => {
  const source = { goplus: { status: 'ok', fetchedAt: at, issues: [] } };
  let state = saveReport(emptyResearchStore(), { ...report(), sourceStatus: source }, 'inspection', savedAt);
  state = saveReport(state, { ...report(), sourceStatus: { goplus: { ...source.goplus, fetchedAt: savedAt } } }, 'inspection', savedAt);
  assert.equal(state.reports.length, 1);
  state = saveReport(state, { ...report(), sourceStatus: source, checks: [] }, 'inspection', savedAt);
  assert.equal(state.reports.length, 2);
  assert.equal(new Set(state.reports.map(r => r.id)).size, 2);
});

test('storage roundtrip validates every report and never trusts nested unknown metadata', () => {
  const disk = storage();
  const state = addWatch(saveReport(emptyResearchStore(), report(), 'inspection', savedAt), token, 'Example', at);
  assert.equal(writeResearchStore(state, disk).saved, true);
  const read = readResearchStore(disk);
  assert.equal(read.writable, true);
  assert.deepEqual(read.warnings, []);
  assert.deepEqual(read.store, state);
  const raw = JSON.parse(disk.raw!);
  raw.reports[0].data.receipt = 'secret';
  raw.reports.push({ ...raw.reports[0], id: 'bad-token', token: address(2) });
  raw.watchlist.push({ token: address(0), addedAt: at });
  disk.raw = JSON.stringify(raw);
  const recovered = readResearchStore(disk);
  assert.equal(recovered.store.reports.length, 1);
  assert.equal(recovered.store.watchlist.length, 1);
  assert.equal(JSON.stringify(recovered.store).includes('secret'), false);
  assert.ok(recovered.warnings.length > 0);
});

test('reloaded invalid dates/origins/reports are omitted, and colliding IDs are repaired', () => {
  const state = saveReport(emptyResearchStore(), report(), 'inspection', savedAt);
  const entry = state.reports[0];
  const disk = storage(JSON.stringify({ ...state, reports: [entry,
    { ...entry, id: 'invalid-date', savedAt: 'yesterday' },
    { ...entry, id: 'invalid-origin', origin: 'trusted' },
    { ...entry, id: 'invalid-report', data: { ...entry.data, chain: 'ethereum' } },
    { ...entry, data: { ...entry.data, name: 'Conflicting snapshot' } }] }));
  const read = readResearchStore(disk);
  assert.equal(read.store.reports.length, 2);
  assert.equal(new Set(read.store.reports.map(r => r.id)).size, 2);
  assert.ok(read.warnings.length > 0);
  assert.throws(() => saveReport(state, report(), 'trusted' as 'inspection', savedAt));
});

test('corrupt, malformed, oversized, and future-version storage stays on disk with a visible warning', () => {
  for (const raw of ['{broken', 'null', '{}', '{"version":2,"watchlist":[],"reports":[]}', '{"version":1,"watchlist":{},"reports":[]}', ' '.repeat(2 * 1024 * 1024 + 1)]) {
    const disk = storage(raw);
    const read = readResearchStore(disk);
    assert.equal(read.writable, false);
    assert.deepEqual(read.store, emptyResearchStore());
    assert.ok(read.warnings.length > 0);
    const write = writeResearchStore(emptyResearchStore(), disk);
    assert.equal(write.saved, false);
    assert.equal(disk.raw, raw);
  }
});

test('blocked storage and quota failure warn without discarding the earlier persisted reports', () => {
  const state = saveReport(emptyResearchStore(), report(), 'inspection', savedAt);
  const original = JSON.stringify(emptyResearchStore());
  const disk = storage(original);
  disk.setItem = () => { throw new DOMException('Full', 'QuotaExceededError'); };
  const failed = writeResearchStore(state, disk);
  assert.equal(failed.saved, false);
  assert.equal(failed.store.reports.length, 1);
  assert.match(failed.warnings.join(' '), /full|space|quota/i);
  assert.equal(disk.raw, original);
  const blocked = { getItem() { throw new Error('Blocked'); }, setItem() { throw new Error('Blocked'); } };
  assert.equal(readResearchStore(blocked).writable, false);
  assert.equal(writeResearchStore(state, blocked).saved, false);
  assert.ok(readResearchStore(null).warnings.length > 0);
});

test('a future version appearing between load and write is never overwritten', () => {
  const disk = storage();
  assert.equal(readResearchStore(disk).writable, true);
  disk.raw = '{"version":7,"futureData":"keep"}';
  assert.equal(writeResearchStore(emptyResearchStore(), disk).saved, false);
  assert.equal(disk.raw, '{"version":7,"futureData":"keep"}');
});

test('reconciliation preserves concurrent watch/report additions without mutating or sharing input data', () => {
  const base = addWatch(saveReport(emptyResearchStore(), report(at, address(1)), 'inspection', savedAt), address(1), 'One', at);
  const local = addWatch(saveReport(base, report(at, address(2)), 'inspection', savedAt), address(2), 'Two', at);
  const remote = addWatch(saveReport(base, report(at, address(3)), 'inspection', savedAt), address(3), 'Three', at);
  const originals = JSON.stringify([base, local, remote]);
  const merged = reconcileResearchStore(base, local, remote);
  assert.deepEqual(merged.watchlist.map(entry => entry.token).sort(), [address(1), address(2), address(3)]);
  assert.deepEqual(merged.reports.map(entry => entry.token).sort(), [address(1), address(2), address(3)]);
  merged.watchlist[0].label = 'Changed output';
  merged.reports[0].data.checks[0].detail = 'Changed output';
  assert.equal(JSON.stringify([base, local, remote]), originals);
});

test('unchanged local records keep remote edits and never resurrect remotely removed data', () => {
  const base = addWatch(saveReport(emptyResearchStore(), report(), 'inspection', savedAt), token, 'Original label', at);
  const remoteRemoved = emptyResearchStore();
  assert.deepEqual(reconcileResearchStore(base, base, remoteRemoved), remoteRemoved);
  const local = structuredClone(base);
  local.reports[0].id = 'different-selector';
  assert.deepEqual(reconcileResearchStore(base, local, remoteRemoved), remoteRemoved);
  const remoteEdited = structuredClone(base);
  remoteEdited.watchlist[0].label = 'Other tab label';
  remoteEdited.reports[0].savedAt = '2026-09-15T12:00:00.000Z';
  assert.deepEqual(reconcileResearchStore(base, base, remoteEdited), remoteEdited);
});

test('local removals affect baseline identities while unrelated remote additions survive a local clear', () => {
  const base = addWatch(saveReport(emptyResearchStore(), report(), 'inspection', savedAt), token, 'Original', at);
  const remote = addWatch(saveReport(base, report(at, address(2)), 'shared', savedAt), address(2), 'Other tab', at);
  remote.watchlist.find(entry => entry.token === token)!.label = 'Remote edit';
  const merged = reconcileResearchStore(base, emptyResearchStore(), remote);
  assert.deepEqual(merged.watchlist.map(entry => entry.token), [address(2)]);
  assert.deepEqual(merged.reports.map(entry => entry.token), [address(2)]);
});

test('explicit local changes survive a remote removal and keep unrelated new remote data', () => {
  const base = addWatch(saveReport(emptyResearchStore(), report(), 'inspection', savedAt), token, 'Original', at);
  const local = structuredClone(base);
  local.watchlist[0].label = 'Local edit';
  local.reports[0].savedAt = '2026-09-15T12:00:00.000Z';
  const remote = addWatch(saveReport(emptyResearchStore(), report(at, address(3)), 'shared', savedAt), address(3), 'Remote addition', at);
  const merged = reconcileResearchStore(base, local, remote);
  assert.equal(merged.watchlist.find(entry => entry.token === token)!.label, 'Local edit');
  assert.equal(merged.reports.find(entry => entry.token === token)!.savedAt, '2026-09-15T12:00:00.000Z');
  assert.ok(merged.watchlist.some(entry => entry.token === address(3)));
  assert.ok(merged.reports.some(entry => entry.token === address(3)));
});

test('report reconciliation uses evidence identities despite colliding selectors and retains every origin', () => {
  const base = saveReport(emptyResearchStore(), report(at, address(1)), 'inspection', savedAt);
  const local = saveReport(emptyResearchStore(), report(at, address(2)), 'inspection', savedAt);
  const remote = saveReport(emptyResearchStore(), report(at, address(3)), 'inspection', savedAt);
  base.reports[0].id = local.reports[0].id = remote.reports[0].id = 'same-selector';
  const merged = reconcileResearchStore(base, local, remote);
  assert.deepEqual(merged.reports.map(entry => entry.token).sort(), [address(2), address(3)]);
  assert.equal(new Set(merged.reports.map(entry => entry.id)).size, 2);
  const example = saveReport(emptyResearchStore(), report(), 'example', savedAt);
  const provenance = reconcileResearchStore(example, saveReport(example, report(), 'inspection', savedAt), saveReport(example, report(), 'shared', savedAt));
  assert.deepEqual(provenance.reports.map(entry => entry.origin).sort(), ['example', 'inspection', 'shared']);
  const disk = storage();
  assert.equal(writeResearchStore(provenance, disk).saved, true);
  assert.deepEqual(readResearchStore(disk).store, provenance);
});

test('pending local additions survive successive remote reads while remote removals remain removed', () => {
  const base = addWatch(saveReport(emptyResearchStore(), report(at, address(1)), 'inspection', savedAt), address(1), '', at);
  const local = addWatch(saveReport(base, report(at, address(2)), 'inspection', savedAt), address(2), '', at);
  const remoteFirst = addWatch(saveReport(emptyResearchStore(), report(at, address(3)), 'inspection', savedAt), address(3), '', at);
  const pending = reconcileResearchStore(base, local, remoteFirst);
  const remoteNext = addWatch(saveReport(emptyResearchStore(), report(at, address(4)), 'inspection', savedAt), address(4), '', at);
  const merged = reconcileResearchStore(remoteFirst, pending, remoteNext);
  assert.deepEqual(merged.watchlist.map(entry => entry.token).sort(), [address(2), address(4)]);
  assert.deepEqual(merged.reports.map(entry => entry.token).sort(), [address(2), address(4)]);
});

test('reconciliation enforces global and per-token limits and retains local watch additions at capacity', () => {
  let local = emptyResearchStore();
  let remote = emptyResearchStore();
  for (let n = 1; n <= 60; n++) {
    local = saveReport(local, report('2026-09-15T12:00:00Z', address(n)), 'inspection', savedAt);
    remote = saveReport(remote, report(at, address(n + 60)), 'inspection', savedAt);
    if (n <= 30) {
      local = addWatch(local, address(n), '', at);
      remote = addWatch(remote, address(n + 30), '', at);
    }
  }
  const merged = reconcileResearchStore(emptyResearchStore(), local, remote);
  assert.equal(merged.watchlist.length, 50);
  assert.equal(merged.reports.length, 100);
  assert.ok(local.watchlist.every(entry => merged.watchlist.some(item => item.token === entry.token)));
  let earlier = emptyResearchStore();
  let later = emptyResearchStore();
  for (let n = 1; n <= 12; n++) {
    const data = report(`2026-09-${String(n).padStart(2, '0')}T10:00:00Z`);
    if (n <= 6) earlier = saveReport(earlier, data, 'inspection', savedAt);
    else later = saveReport(later, data, 'inspection', savedAt);
  }
  const history = reconcileResearchStore(emptyResearchStore(), later, earlier);
  assert.equal(history.reports.length, 10);
  assert.equal(history.reports[0].data.at, '2026-09-12T10:00:00.000Z');
  assert.equal(history.reports.at(-1)!.data.at, '2026-09-03T10:00:00.000Z');
});

test('reconciliation keeps the serialized byte budget when both tabs added large reports', () => {
  let local = emptyResearchStore();
  let remote = emptyResearchStore();
  const evidence = Array.from({ length: 30 }, (_, i) => `${String(i).padStart(2, '0')}:` + 'e'.repeat(157));
  const ids = ['honeypot', 'taxes', 'verified', 'owner-powers', 'concentration', 'liquidity', 'creator-stake', 'deployer'];
  for (let n = 1; n <= 12; n++) {
    const data = { ...report(at, address(n)), checks: ids.map(id => ({ id, status: 'unknown', complete: false, detail: 'D'.repeat(2000), missing: evidence, conflicts: evidence, sources: evidence })) };
    if (n % 2) local = saveReport(local, data, 'inspection', savedAt);
    else remote = saveReport(remote, data, 'inspection', savedAt);
  }
  const merged = reconcileResearchStore(emptyResearchStore(), local, remote);
  assert.ok(merged.reports.length > 0 && merged.reports.length < 12);
  assert.ok(JSON.stringify(merged).length * 2 <= 2 * 1024 * 1024);
});
