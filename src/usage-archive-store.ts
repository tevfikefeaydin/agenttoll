import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ARCHIVE_LIMITS, archiveDate, archiveRows, updateArchiveEntries,
  validateArchiveEntry, validateUsageArchive, type Entry } from './usage-archive.js';
import { summarizeUsageRows } from './usage-report.js';

export const STORE_LIMITS = {
  retentionDays: 30, maxEntries: 500_000, maxBytes: 384 * 1024 * 1024,
  maxSegmentEntries: 5000, maxSegmentBytes: 5 * 1024 * 1024, maxSegments: 128,
  maxInputBytes: ARCHIVE_LIMITS.maxBytes, maxLineBytes: ARCHIVE_LIMITS.maxLineBytes,
  maxManifestBytes: 25 * 1024 * 1024,
} as const;
type Segment = { file: string; sha256: string; bytes: number; entries: number };
type State = { version: 2; startedAt: string; collectedAt: string; entryCount: number; segments: Segment[] };
export type Collection = { input: string; now: string; containers: string[];
  sourceWindowSince: string; sourceWindowUntil: string; collectionBacklogSeconds: number };
type ObjectValue = Record<string, unknown>;
type Stage = 'request' | 'load' | 'merge' | 'report' | 'segments' | 'manifest' | 'manifest-durability';
export class UsageArchiveStoreError extends Error {
  constructor(public readonly stage: Stage) { super(`Usage archive failed during ${stage}; inspect the last committed manifest.`); }
}
const object = (value: unknown): value is ObjectValue => !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value: ObjectValue, expected: string) => Object.keys(value).sort().join() === expected;
const integer = (value: unknown, min: number, max: number): value is number => Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max;
const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
function requireValue(condition: unknown): asserts condition { if (!condition) throw new Error('Invalid archive'); }
function utc(value: unknown): value is string {
  return typeof value === 'string' && archiveDate(value.replace(/\+00:00$/, 'Z'));
}
function containers(value: unknown): asserts value is string[] {
  requireValue(Array.isArray(value) && value.length > 0 && value.length <= 256 &&
    value.every(item => typeof item === 'string' && /^[a-f0-9]{64}$/.test(item)) && new Set(value).size === value.length);
}
function validateRequest(value: unknown): asserts value is Collection {
  requireValue(object(value) && keys(value, 'collectionBacklogSeconds,containers,input,now,sourceWindowSince,sourceWindowUntil') &&
    typeof value.input === 'string' && Buffer.byteLength(value.input) <= STORE_LIMITS.maxInputBytes && archiveDate(value.now) &&
    utc(value.sourceWindowSince) && utc(value.sourceWindowUntil) &&
    Date.parse(value.sourceWindowSince) <= Date.parse(value.sourceWindowUntil) && Date.parse(value.sourceWindowUntil) <= Date.parse(value.now) &&
    typeof value.collectionBacklogSeconds === 'number' && Number.isFinite(value.collectionBacklogSeconds) && value.collectionBacklogSeconds >= 0);
  containers(value.containers);
}
function stat(file: string) {
  try { return fs.lstatSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
/** Check every component; recursive mkdir must never follow an operator-supplied symlink. */
function privateDirectory(directory: string) {
  const absolute = path.resolve(directory), parsed = path.parse(absolute);
  let current = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const existing = stat(current);
    if (!existing) fs.mkdirSync(current, { mode: 0o700 });
    const info = fs.lstatSync(current);
    requireValue(info.isDirectory() && !info.isSymbolicLink());
  }
  fs.chmodSync(absolute, 0o700);
}
function regular(file: string, maximum: number): Buffer {
  const before = fs.lstatSync(file);
  requireValue(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size <= maximum);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(fd);
    requireValue(opened.isFile() && opened.nlink === 1 && opened.size <= maximum && opened.ino === before.ino && opened.dev === before.dev);
    const data = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < data.length) {
      const size = fs.readSync(fd, data, offset, data.length - offset, offset);
      requireValue(size > 0); offset += size;
    }
    requireValue(fs.readSync(fd, Buffer.alloc(1), 0, 1, offset) === 0);
    return data;
  } finally { fs.closeSync(fd); }
}
function syncDirectory(directory: string) {
  // Windows does not expose POSIX directory fsync through Node. Production is Linux.
  if (process.platform === 'win32') return;
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function writeTemporary(directory: string, payload: string): string {
  const file = path.join(directory, `.archive-${randomUUID()}.tmp`);
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, payload); fs.fsyncSync(fd); }
  catch (error) { fs.closeSync(fd); fs.unlinkSync(file); throw error; }
  fs.closeSync(fd);
  return file;
}
function load(directory: string, now: string) {
  const file = path.join(directory, 'archive.json');
  const entries = new Map<string, Entry>();
  if (!stat(file)) return { entries, startedAt: now, collectedAt: null, containers: [] as string[], coverage: {} as ObjectValue };
  const value: unknown = JSON.parse(regular(file, STORE_LIMITS.maxManifestBytes).toString('utf8'));
  requireValue(object(value) && keys(value, 'bundle,containers,version') && (value.version === 1 || value.version === 2) &&
    object(value.bundle) && keys(value.bundle, 'report,state') && object(value.bundle.report) && object(value.bundle.state));
  containers(value.containers);
  const state = value.bundle.state;
  const coverage = value.bundle.report.coverage;
  requireValue(object(coverage));
  if (value.version === 1) {
    validateUsageArchive(state);
    for (const entry of state.entries) entries.set(entry.id, entry);
  } else {
    requireValue(keys(state, 'collectedAt,entryCount,segments,startedAt,version') && state.version === 2 &&
      archiveDate(state.startedAt) && archiveDate(state.collectedAt) && Date.parse(state.startedAt) <= Date.parse(state.collectedAt) &&
      integer(state.entryCount, 0, STORE_LIMITS.maxEntries) && Array.isArray(state.segments) && state.segments.length <= STORE_LIMITS.maxSegments);
    let totalBytes = 0, totalEntries = 0;
    const files = new Set<string>();
    // Reject impossible manifests before opening any referenced segment.
    for (const segment of state.segments) {
      requireValue(object(segment) && keys(segment, 'bytes,entries,file,sha256') &&
        typeof segment.sha256 === 'string' && /^[a-f0-9]{64}$/.test(segment.sha256) && segment.file === `segments/${segment.sha256}.json` &&
        integer(segment.bytes, 2, STORE_LIMITS.maxSegmentBytes) && integer(segment.entries, 1, STORE_LIMITS.maxSegmentEntries));
      requireValue(!files.has(segment.file)); files.add(segment.file);
      totalBytes += segment.bytes; totalEntries += segment.entries;
      requireValue(totalBytes <= STORE_LIMITS.maxBytes && totalEntries <= STORE_LIMITS.maxEntries);
    }
    requireValue(totalEntries === state.entryCount);
    for (const segment of state.segments as Segment[]) {
      const bytes = regular(path.join(directory, segment.file), STORE_LIMITS.maxSegmentBytes);
      requireValue(bytes.length === segment.bytes && sha256(bytes) === segment.sha256);
      const records: unknown = JSON.parse(bytes.toString('utf8'));
      requireValue(Array.isArray(records) && records.length === segment.entries);
      for (const entry of records) {
        validateArchiveEntry(entry, state.collectedAt);
        requireValue(!entries.has(entry.id)); entries.set(entry.id, entry);
      }
    }
    requireValue(utc(coverage.sourceWindowSince) && utc(coverage.sourceWindowUntil) &&
      Date.parse(coverage.sourceWindowSince) <= Date.parse(coverage.sourceWindowUntil) && Date.parse(coverage.sourceWindowUntil) <= Date.parse(state.collectedAt));
  }
  requireValue(archiveDate(state.startedAt) && archiveDate(state.collectedAt) && Date.parse(state.collectedAt) <= Date.parse(now));
  for (const key of ['lastDelayedCollectionAt', 'lastMissingContainersAt']) {
    if (coverage[key] !== undefined && coverage[key] !== null) requireValue(archiveDate(coverage[key]) && Date.parse(coverage[key]) <= Date.parse(state.collectedAt));
  }
  return { entries, startedAt: state.startedAt, collectedAt: state.collectedAt, containers: value.containers, coverage };
}
/** A single segment is serialized at a time; never stringify the combined archive. */
function* pack(entries: Iterable<Entry>) {
  let rows: string[] = [], bytes = 2;
  function result() {
    const data = `[${rows.join(',')}]`, digest = sha256(data);
    return { data, segment: { file: `segments/${digest}.json`, sha256: digest, bytes, entries: rows.length } satisfies Segment };
  }
  for (const entry of entries) {
    const row = JSON.stringify(entry), size = Buffer.byteLength(row);
    requireValue(size + 2 <= STORE_LIMITS.maxSegmentBytes);
    if (rows.length && (rows.length === STORE_LIMITS.maxSegmentEntries || bytes + size + 1 > STORE_LIMITS.maxSegmentBytes)) {
      yield result(); rows = []; bytes = 2;
    }
    bytes += size + (rows.length ? 1 : 0); rows.push(row);
  }
  if (rows.length) yield result();
}
function cleanup(directory: string, referenced: Set<string>) {
  // Only our hash-named regular files are eligible. Unknown files and links stay untouched.
  const segmentDirectory = path.join(directory, 'segments');
  for (const file of fs.readdirSync(segmentDirectory)) {
    if (!/^[a-f0-9]{64}\.json$/.test(file) || referenced.has(`segments/${file}`)) continue;
    const target = path.join(segmentDirectory, file), info = fs.lstatSync(target);
    if (info.isFile() && !info.isSymbolicLink() && info.nlink === 1) fs.unlinkSync(target);
  }
  syncDirectory(segmentDirectory);
}
/** Caller holds the collection lock. A manifest replacement is the commit point. */
export function updateUsageArchiveStore(directory: string, request: unknown) {
  let stage: Stage = 'request';
  try {
    validateRequest(request);
    const root = path.resolve(directory), segmentDirectory = path.join(root, 'segments');
    stage = 'load';
    privateDirectory(root); privateDirectory(segmentDirectory);
    const previous = load(root, request.now);
    const cutoff = Date.parse(request.now) - STORE_LIMITS.retentionDays * 86_400_000;
    for (const [id, entry] of previous.entries) if (Date.parse(entry.firstSeen) < cutoff) previous.entries.delete(id);
    stage = 'merge';
    const ignored = updateArchiveEntries(previous.entries, request.input, request.now, STORE_LIMITS.maxEntries);
    const segments: Segment[] = [];
    let bytes = 0;
    for (const packed of pack(previous.entries.values())) {
      segments.push(packed.segment); bytes += packed.segment.bytes;
      requireValue(segments.length <= STORE_LIMITS.maxSegments && bytes <= STORE_LIMITS.maxBytes);
    }
    stage = 'report';
    const summary = summarizeUsageRows(archiveRows(previous.entries.values()));
    const missing = previous.containers.filter(id => !request.containers.includes(id)).length;
    const delayed = (!!previous.collectedAt && Date.parse(request.now) - Date.parse(previous.collectedAt) > 600_000) || request.collectionBacklogSeconds > 600;
    const lastDelayed = delayed ? request.now : previous.coverage.lastDelayedCollectionAt ??
      (previous.coverage.delayedCollection === true ? previous.collectedAt : null);
    const lastMissing = missing ? request.now : previous.coverage.lastMissingContainersAt ??
      (Number(previous.coverage.previousContainersNowMissing) > 0 ? previous.collectedAt : null);
    const utilization = { entries: previous.entries.size, bytes, segments: segments.length,
      entryFraction: previous.entries.size / STORE_LIMITS.maxEntries, byteFraction: bytes / STORE_LIMITS.maxBytes,
      segmentFraction: segments.length / STORE_LIMITS.maxSegments };
    const state: State = { version: 2, startedAt: previous.startedAt, collectedAt: request.now,
      entryCount: previous.entries.size, segments };
    const result = { version: 2 as const, containers: request.containers, bundle: { state, report: { ...summary, coverage: {
      complete: false, retainedSince: summary.window.firstRequestAt, collectionStartedAt: previous.startedAt,
      collectedAt: request.now, previousCollectionAt: previous.collectedAt, delayedCollection: delayed,
      lastDelayedCollectionAt: lastDelayed, previousContainersNowMissing: missing, lastMissingContainersAt: lastMissing,
      managedContainersObserved: request.containers.length, sourceWindowSince: request.sourceWindowSince,
      sourceWindowUntil: request.sourceWindowUntil, collectionBacklogSeconds: request.collectionBacklogSeconds,
      ignoredLinesThisCollection: ignored, limits: STORE_LIMITS, utilization, segmentCount: segments.length,
      capacityWarning: Math.max(utilization.entryFraction, utilization.byteFraction, utilization.segmentFraction) >= 0.8,
      reportScope: 'all-retained-archive-entries',
      warning: 'Best-effort retained observations only. Reports cover all retained segments, not just this collection window. Rotation, deletion and container replacement can lose logs. Conflicts and receipt deduplication apply only within retained records. Empty periods are not proof of zero activity. Delay and missing-source history cannot establish complete coverage.',
    } } } };
    const payload = JSON.stringify(result);
    requireValue(Buffer.byteLength(payload) <= STORE_LIMITS.maxManifestBytes);
    stage = 'segments';
    for (const packed of pack(previous.entries.values())) {
      const target = path.join(root, packed.segment.file);
      if (stat(target)) {
        requireValue(regular(target, STORE_LIMITS.maxSegmentBytes).equals(Buffer.from(packed.data)));
        fs.chmodSync(target, 0o600);
      } else {
        const temporary = writeTemporary(segmentDirectory, packed.data);
        try { fs.renameSync(temporary, target); } finally { if (stat(temporary)) fs.unlinkSync(temporary); }
      }
    }
    syncDirectory(segmentDirectory);
    stage = 'manifest';
    const target = path.join(root, 'archive.json'), existing = stat(target);
    requireValue(!existing || (existing.isFile() && !existing.isSymbolicLink() && existing.nlink === 1));
    const temporary = writeTemporary(root, payload);
    try { fs.renameSync(temporary, target); } finally { if (stat(temporary)) fs.unlinkSync(temporary); }
    stage = 'manifest-durability';
    syncDirectory(root);
    // A cleanup failure cannot invalidate or undo an already durable collection.
    try { cleanup(root, new Set(segments.map(segment => segment.file))); } catch { /* Retry after a later successful commit. */ }
    return result;
  } catch { throw new UsageArchiveStoreError(stage); }
}
