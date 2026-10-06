import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs, { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { updateUsageArchive } from '../src/usage-archive.js';
import { updateUsageArchiveStore, STORE_LIMITS } from '../src/usage-archive-store.js';

const NOW = '2026-10-01T12:00:00.000Z';
const LATER = '2026-10-01T12:05:00.000Z';
const CID = 'a'.repeat(64);
const script = fileURLToPath(new URL('../scripts/usage-archive-store.mjs', import.meta.url));
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const receipt = (id: string, extra = {}) => ({ schemaVersion: 2, requestId: id, t: NOW,
  method: 'GET', route: '/api/gas', status: 200, terminal: 'finish', abortReason: null,
  paymentHeader: 'payment-signature', protocolVersion: 'v2', paymentPhase: 'settle', paymentReason: null,
  facilitatorVerifyCalls: 1, facilitatorSettleCalls: 1, facilitatorVerifyMs: 1, facilitatorSettleMs: 1,
  paymentStage: 'settled', paymentSubmitted: true, verifiedPayer: '0x' + 'ab'.repeat(20),
  settlementTransaction: '0x' + '12'.repeat(32), settlementAmount: '1000',
  settlementAsset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', settlementNetwork: 'eip155:8453', ...extra });
const quote = (id: string, extra = {}) => receipt(id, { status: 402, paymentHeader: 'none',
  protocolVersion: 'none', paymentPhase: 'parse', paymentReason: 'payment_required',
  paymentStage: 'quote', paymentSubmitted: false, verifiedPayer: null, settlementTransaction: null,
  settlementAmount: null, settlementAsset: null, settlementNetwork: null,
  facilitatorVerifyCalls: 0, facilitatorSettleCalls: 0, ...extra });
const lines = (rows: object[]) => rows.map(row => JSON.stringify(row)).join('\n');
function directory(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(path.join(tmpdir(), 'agenttoll-segments-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function run(root: string, input = '', now = NOW, containers = [CID]) {
  return spawnSync(process.execPath, ['--import', 'tsx', script, '--directory', root], {
    input: JSON.stringify({ input, now, containers, sourceWindowSince: '2026-10-01T11:50:00+00:00',
      sourceWindowUntil: now, collectionBacklogSeconds: 0 }),
    encoding: 'utf8', timeout: 60_000, maxBuffer: 2 * 1024 * 1024,
  });
}
function collect(root: string, input = '', now = NOW, containers = [CID]) {
  const result = run(root, input, now, containers);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
const manifest = (root: string) => JSON.parse(readFileSync(path.join(root, 'archive.json'), 'utf8'));
const request = (input = '', now = NOW, extra = {}) => ({ input, now, containers: [CID],
  sourceWindowSince: '2026-10-01T11:50:00+00:00', sourceWindowUntil: now, collectionBacklogSeconds: 0, ...extra });

test('segmented archive preserves optional diagnostic details across process restart and overlap', t => {
  const root = directory(t);
  collect(root, lines([receipt('historical-success')]));
  const diagnostic = { version: 1, code: 'facilitator_declined', providerCode: 'invalid_exact_evm_signature', providerHttpStatus: 400 };
  const rejected = quote('diagnostic-rejection', { paymentHeader: 'payment-signature', paymentSubmitted: true,
    protocolVersion: 'v2', paymentPhase: 'verify', paymentReason: 'verification_declined', paymentStage: 'rejected',
    facilitatorVerifyCalls: 1, paymentDiagnostic: { ...diagnostic, privateResponse: 'DO-NOT-PERSIST' } });
  const input = lines([rejected]);
  const updated = collect(root, input, LATER);
  const restarted = collect(root, input, LATER);
  assert.equal(restarted.bundle.report.settlements.confirmedUnique, 1);
  assert.equal(restarted.bundle.report.settlements.usdc.total, '0.001000');
  assert.equal(restarted.bundle.report.paymentDiagnostics.total, 1);
  assert.equal(restarted.bundle.report.paymentDiagnostics.withDetails, 1);
  assert.deepEqual(restarted.bundle.report.paymentDiagnostics, updated.bundle.report.paymentDiagnostics);
  const persisted = entries(root);
  assert.deepEqual(persisted.find((e: any) => e.row.paymentDiagnostic)?.row.paymentDiagnostic, diagnostic);
  assert.doesNotMatch(JSON.stringify([restarted, persisted]), /DO-NOT-PERSIST|privateResponse/);
});
function entries(root: string, saved = manifest(root)) {
  return saved.bundle.state.segments.flatMap((segment: { file: string }) => JSON.parse(readFileSync(path.join(root, segment.file), 'utf8')));
}

test('legacy migration preserves complete entries and exact global usage totals', t => {
  const root = directory(t);
  const first = updateUsageArchive(null, lines([receipt('paid'), receipt('replayed-receipt'), quote('quote'),
    receipt('conflict', { secret: 'original-private-value' })]), NOW);
  const legacy = updateUsageArchive(first.state, lines([receipt('conflict', { secret: 'changed-private-value' })]), NOW);
  writeFileSync(path.join(root, 'archive.json'), JSON.stringify({ version: 1, containers: [CID], bundle: legacy }));
  const saved = collect(root, '', LATER);
  assert.equal(saved.version, 2);
  assert.equal(saved.bundle.state.startedAt, NOW);
  assert.deepEqual(entries(root), legacy.state.entries);
  assert.equal(saved.bundle.report.requests.quotes, 1);
  assert.equal(saved.bundle.report.requests.signedSubmissions, 2);
  assert.equal(saved.bundle.report.settlements.confirmedUnique, 1);
  assert.equal(saved.bundle.report.settlements.usdc.total, '0.001000');
  assert.equal(saved.bundle.report.input.conflictingRequestIds, 1);
  const { coverage: oldCoverage, ...oldMetrics } = legacy.report;
  const { coverage: newCoverage, ...newMetrics } = saved.bundle.report;
  assert.deepEqual(newMetrics, oldMetrics);
  assert.equal(saved.bundle.report.coverage.previousCollectionAt, NOW);
  assert.doesNotMatch(JSON.stringify(saved) + JSON.stringify(entries(root)), /private-value|"secret"/);
});

test('rotation and restart deduplicate requests and receipts across segment boundaries', t => {
  const root = directory(t);
  const rows = [receipt('paid'), ...Array.from({ length: 5000 }, (_, i) => quote(`quote-${i}`)), receipt('other-id-same-receipt')];
  const first = collect(root, lines(rows));
  assert.equal(first.bundle.state.entryCount, 5002);
  assert.equal(first.bundle.state.segments.length, 2);
  const next = collect(root, lines([rows[0], rows[5000], rows[5001]]), LATER);
  assert.equal(next.bundle.state.entryCount, 5002);
  assert.equal(next.bundle.report.requests.quotes, 5000);
  assert.equal(next.bundle.report.settlements.confirmedUnique, 1);
  assert.deepEqual(next.bundle.state.segments, first.bundle.state.segments);
  for (const segment of next.bundle.state.segments) {
    const bytes = readFileSync(path.join(root, segment.file));
    assert.equal(segment.sha256, digest(bytes));
    assert.equal(segment.file, `segments/${digest(bytes)}.json`);
    assert.equal(segment.bytes, bytes.length);
    assert.ok(segment.entries <= 5000);
    assert.ok(bytes.length <= 5 * 1024 * 1024);
  }
});

test('cross-segment discarded-field request conflicts and receipt conflicts exclude revenue', t => {
  const root = directory(t);
  collect(root, lines([receipt('request-conflict', { secret: 'first' }),
    receipt('receipt-conflict', { settlementTransaction: '0x' + '34'.repeat(32) }),
    ...Array.from({ length: 5000 }, (_, i) => quote(`q-${i}`))]));
  const next = collect(root, lines([receipt('request-conflict', { secret: 'second' }),
    receipt('receipt-other-id', { settlementTransaction: '0x' + '34'.repeat(32), settlementAmount: '2000' })]), LATER);
  assert.equal(next.bundle.report.input.conflictingRequestIds, 1);
  assert.equal(next.bundle.report.settlements.unresolved.conflictingReceipts, 1);
  assert.equal(next.bundle.report.settlements.confirmedUnique, 0);
  assert.equal(next.bundle.report.requests.quotes, 5000);
  const again = collect(root, lines([receipt('request-conflict', { secret: 'first' })]), LATER);
  assert.equal(again.bundle.report.input.conflictingRequestIds, 1);
});

test('a full legacy archive can grow beyond 20 MiB without losing quotes', t => {
  const root = directory(t);
  let old = updateUsageArchive(null, '', NOW);
  // Short batches obey the existing input bound while reaching the actual state bound.
  for (let start = 0; start < 25000; start += 5000) {
    old = updateUsageArchive(old.state, lines(Array.from({ length: 5000 }, (_, i) => quote(`legacy-${start + i}`))), NOW);
  }
  assert.ok(Buffer.byteLength(JSON.stringify(old.state)) < 20 * 1024 * 1024);
  writeFileSync(path.join(root, 'archive.json'), JSON.stringify({ version: 1, containers: [CID], bundle: old }));
  const saved = collect(root, lines(Array.from({ length: 10000 }, (_, i) => quote(`new-${i}`))), LATER);
  assert.equal(saved.bundle.state.entryCount, 35000);
  assert.equal(saved.bundle.report.requests.quotes, 35000);
  assert.ok(saved.bundle.report.coverage.utilization.bytes > 20 * 1024 * 1024);
  assert.equal(entries(root).filter((entry: { firstSeen: string }) => entry.firstSeen === NOW).length, 25000);
});

test('failure before manifest replacement leaves last-good bytes and ignores orphan segments on restart', t => {
  const root = directory(t);
  const first = updateUsageArchiveStore(root, request(lines([quote('old')])));
  const before = readFileSync(path.join(root, 'archive.json'));
  const rename = fs.renameSync;
  const fault = t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
    if (String(to) === path.join(root, 'archive.json')) throw new Error('private failure detail');
    rename(from, to);
  });
  assert.throws(() => updateUsageArchiveStore(root, request(lines([quote('new')]), LATER)), /during manifest/);
  fault.mock.restore();
  assert.deepEqual(readFileSync(path.join(root, 'archive.json')), before);
  assert.ok(readdirSync(path.join(root, 'segments')).length > first.bundle.state.segments.length);
  const resumed = updateUsageArchiveStore(root, request(lines([quote('new')]), LATER));
  assert.equal(resumed.bundle.state.entryCount, 2);
  assert.equal(resumed.bundle.report.requests.quotes, 2);
  assert.equal(readdirSync(path.join(root, 'segments')).length, resumed.bundle.state.segments.length);
});

test('failure immediately after manifest replacement is recoverable without recounting', t => {
  const root = directory(t);
  const first = updateUsageArchiveStore(root, request(lines([quote('old')])));
  const rename = fs.renameSync;
  const fault = t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
    rename(from, to);
    if (String(to) === path.join(root, 'archive.json')) throw new Error('simulated process loss after rename');
  });
  assert.throws(() => updateUsageArchiveStore(root, request(lines([quote('new')]), LATER)));
  fault.mock.restore();
  assert.equal(manifest(root).bundle.state.entryCount, 2);
  assert.ok(fs.existsSync(path.join(root, first.bundle.state.segments[0].file)), 'old generation remains until commit is durable');
  const resumed = updateUsageArchiveStore(root, request(lines([quote('old'), quote('new')]), LATER));
  assert.equal(resumed.bundle.report.requests.quotes, 2);
  assert.equal(resumed.bundle.state.entryCount, 2);
});

test('segment fsync failure cannot publish a new cursor', t => {
  const root = directory(t);
  updateUsageArchiveStore(root, request(lines([quote('old')])));
  const before = readFileSync(path.join(root, 'archive.json'));
  const fault = t.mock.method(fs, 'fsyncSync', () => { throw new Error('disk failure'); });
  assert.throws(() => updateUsageArchiveStore(root, request(lines([quote('new')]), LATER)), /during segments/);
  fault.mock.restore();
  assert.deepEqual(readFileSync(path.join(root, 'archive.json')), before);
  assert.equal(updateUsageArchiveStore(root, request(lines([quote('new')]), LATER)).bundle.report.requests.quotes, 2);
});

test('missing, corrupt and path-traversing references fail closed without changing the manifest', t => {
  for (const damage of ['missing', 'bytes', 'traversal', 'count', 'version', 'future', 'unsafe-row']) {
    const root = directory(t);
    updateUsageArchiveStore(root, request(lines([receipt('paid')])));
    const saved = manifest(root), segment = saved.bundle.state.segments[0];
    const target = path.join(root, segment.file);
    if (damage === 'missing') rmSync(target);
    if (damage === 'bytes') writeFileSync(target, '[]');
    if (damage === 'traversal') segment.file = '../outside.json';
    if (damage === 'count') saved.bundle.state.entryCount++;
    if (damage === 'version') saved.version = '2';
    if (damage === 'future' || damage === 'unsafe-row') {
      const records = entries(root);
      if (damage === 'future') records[0].firstSeen = '2026-10-02T00:00:00.000Z';
      else records[0].row.secret = 'must-not-persist';
      const data = JSON.stringify(records);
      segment.sha256 = digest(data); segment.file = `segments/${segment.sha256}.json`; segment.bytes = Buffer.byteLength(data);
      writeFileSync(path.join(root, segment.file), data);
    }
    writeFileSync(path.join(root, 'archive.json'), JSON.stringify(saved));
    const before = readFileSync(path.join(root, 'archive.json'));
    assert.throws(() => updateUsageArchiveStore(root, request('', LATER)), /during load/, damage);
    assert.deepEqual(readFileSync(path.join(root, 'archive.json')), before);
  }
});

test('retention uses firstSeen and preserves conflicts until the full thirty days expire', t => {
  const root = directory(t);
  const historical = '2026-09-10T12:00:00.000Z';
  updateUsageArchiveStore(root, request(lines([receipt('conflict', { t: historical, secret: 'one' }), quote('quote')])));
  updateUsageArchiveStore(root, request(lines([receipt('conflict', { t: historical, secret: 'two' })]), LATER));
  const boundary = '2026-10-31T12:00:00.000Z';
  const retained = updateUsageArchiveStore(root, request('', boundary));
  assert.equal(retained.bundle.state.entryCount, 2);
  assert.equal(retained.bundle.report.input.conflictingRequestIds, 1);
  assert.equal(retained.bundle.report.requests.quotes, 1);
  const expired = updateUsageArchiveStore(root, request('', '2026-10-31T12:00:00.001Z'));
  assert.equal(expired.bundle.state.entryCount, 0);
  assert.deepEqual(expired.bundle.state.segments, []);
  assert.equal(readdirSync(path.join(root, 'segments')).length, 0);
});

test('bounded-window cursor and historical coverage warnings survive later healthy collections', t => {
  const root = directory(t), other = 'b'.repeat(64);
  updateUsageArchiveStore(root, request(lines([quote('old')]), NOW, { containers: [CID, other] }));
  const late = '2026-10-01T14:00:00.000Z';
  const delayed = updateUsageArchiveStore(root, request(lines([quote('new')]), late, {
    sourceWindowUntil: '2026-10-01T13:00:00+00:00', collectionBacklogSeconds: 3600,
  }));
  assert.equal(delayed.bundle.report.coverage.sourceWindowUntil, '2026-10-01T13:00:00+00:00');
  assert.equal(delayed.bundle.report.coverage.collectionBacklogSeconds, 3600);
  assert.equal(entries(root).find((entry: { id: string }) => entry.id === digest('new')).firstSeen, late);
  const recovered = updateUsageArchiveStore(root, request('', '2026-10-01T14:05:00.000Z'));
  assert.equal(recovered.bundle.report.coverage.delayedCollection, false);
  assert.equal(recovered.bundle.report.coverage.previousContainersNowMissing, 0);
  assert.equal(recovered.bundle.report.coverage.lastDelayedCollectionAt, late);
  assert.equal(recovered.bundle.report.coverage.lastMissingContainersAt, late);
  assert.equal(recovered.bundle.report.requests.quotes, 2);
});

test('invalid cursor ranges and capacity metadata fail before replacing last-good state', t => {
  const root = directory(t);
  updateUsageArchiveStore(root, request(lines([quote('old')])));
  const before = readFileSync(path.join(root, 'archive.json'));
  for (const extra of [
    { sourceWindowUntil: '2026-10-01T11:00:00Z' }, { sourceWindowUntil: '2026-10-02T00:00:00Z' },
    { collectionBacklogSeconds: -1 }, { containers: [CID, CID] },
  ]) assert.throws(() => updateUsageArchiveStore(root, request('', NOW, extra)), /during request/);
  assert.deepEqual(readFileSync(path.join(root, 'archive.json')), before);
  const saved = manifest(root);
  saved.bundle.state.entryCount = STORE_LIMITS.maxEntries + 1;
  writeFileSync(path.join(root, 'archive.json'), JSON.stringify(saved));
  assert.throws(() => updateUsageArchiveStore(root, request()), /during load/);
});

test('unreferenced files are not report inputs and cleanup leaves unrelated files alone', t => {
  const root = directory(t);
  updateUsageArchiveStore(root, request(lines([quote('old')])));
  const orphan = path.join(root, 'segments', 'f'.repeat(64) + '.json');
  writeFileSync(orphan, 'corrupt unreferenced data');
  writeFileSync(path.join(root, 'segments', 'operator-backup.json'), 'keep');
  const saved = updateUsageArchiveStore(root, request('', LATER));
  assert.equal(saved.bundle.report.requests.quotes, 1);
  assert.equal(fs.existsSync(orphan), false);
  assert.equal(readFileSync(path.join(root, 'segments', 'operator-backup.json'), 'utf8'), 'keep');
  if (process.platform !== 'win32') {
    for (const file of [path.join(root, 'archive.json'), ...saved.bundle.state.segments.map(segment => path.join(root, segment.file))])
      assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(root).mode & 0o777, 0o700);
    assert.equal(statSync(path.join(root, 'segments')).mode & 0o777, 0o700);
  }
});

test('symlinked directories are rejected before writing through them', t => {
  const root = directory(t), outside = directory(t);
  const linked = path.join(root, 'linked'); symlinkSync(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => updateUsageArchiveStore(linked, request()), /during load/);
  assert.deepEqual(readdirSync(outside), []);
});

test('symlinked referenced segment files are rejected', { skip: process.platform === 'win32' }, t => {
  const root = directory(t), outside = directory(t);
  const saved = updateUsageArchiveStore(root, request(lines([quote('old')])));
  const segment = path.join(root, saved.bundle.state.segments[0].file);
  const copied = path.join(outside, 'evidence.json');
  writeFileSync(copied, readFileSync(segment)); rmSync(segment); symlinkSync(copied, segment);
  assert.throws(() => updateUsageArchiveStore(root, request('', LATER)), /during load/);
});

test('CLI errors never echo malformed input, paths, or private exception details', t => {
  const root = directory(t);
  writeFileSync(path.join(root, 'archive.json'), 'private-malformed-secret');
  const result = run(root, lines([quote('private-request-id', { secret: 'private-value' })]));
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /failed during load/);
  assert.doesNotMatch(result.stderr, /private-|agenttoll-segments-|SyntaxError| at /);
});

test('entry, byte and segment capacity failures preserve the previous durable generation', t => {
  // Small budgets exercise the same production checks without allocating 384 MiB in a unit test.
  for (const overrides of [{ maxEntries: 2 }, { maxBytes: 1800 }, { maxSegments: 1, maxSegmentEntries: 1 }]) {
    const original = { ...STORE_LIMITS };
    try {
      for (const [key, value] of Object.entries(overrides)) Object.defineProperty(STORE_LIMITS, key, { value });
      const root = directory(t);
      updateUsageArchiveStore(root, request(lines([quote('old')])));
      const before = readFileSync(path.join(root, 'archive.json'));
      assert.throws(() => updateUsageArchiveStore(root, request(lines([quote('new-a'), quote('new-b')]), LATER)), /during merge/);
      assert.deepEqual(readFileSync(path.join(root, 'archive.json')), before);
      assert.equal(updateUsageArchiveStore(root, request('', LATER)).bundle.report.requests.quotes, 1);
    } finally {
      for (const [key, value] of Object.entries(original)) Object.defineProperty(STORE_LIMITS, key, { value });
    }
  }
});

test('byte-limited segments preserve all records when the byte bound precedes the entry bound', t => {
  const original = STORE_LIMITS.maxSegmentBytes;
  try {
    Object.defineProperty(STORE_LIMITS, 'maxSegmentBytes', { value: 1200 });
    const root = directory(t);
    const saved = updateUsageArchiveStore(root, request(lines([quote('a'), quote('b'), quote('c')])));
    assert.equal(saved.bundle.state.segments.length, 3);
    assert.equal(saved.bundle.report.requests.quotes, 3);
    assert.ok(saved.bundle.state.segments.every(segment => segment.bytes <= 1200));
  } finally { Object.defineProperty(STORE_LIMITS, 'maxSegmentBytes', { value: original }); }
});
