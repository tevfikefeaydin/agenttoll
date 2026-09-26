import { createHash } from 'node:crypto';
import { summarizeUsageLogs } from './usage-report.js';
import { canonicalRoute } from './telemetry.js';
import { ENDPOINT_MANIFEST } from './endpoint-manifest.js';
import { paymentPhases, paymentReasons } from './payment-telemetry.js';

type Row = Record<string, unknown>;
type Entry = { id: string; digest: string; firstSeen: string; conflict: boolean; row: Row };
export type UsageArchive = { version: 1; startedAt: string; collectedAt: string; entries: Entry[] };
export const ARCHIVE_LIMITS = { retentionDays: 30, maxEntries: 50_000, maxBytes: 20 * 1024 * 1024, maxLineBytes: 65_536 } as const;
const DAY = 86_400_000;
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const digestPattern = /^[a-f0-9]{64}$/;
const date = (v: unknown): v is string => typeof v === 'string' &&
 /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(v) && Number.isFinite(Date.parse(v)) &&
 new Date(v).toISOString().slice(0, 19) === v.slice(0, 19);
const object = (v: unknown): v is Row => !!v && typeof v === 'object' && !Array.isArray(v);
const routes = new Set<string>(ENDPOINT_MANIFEST.map(e => e.path));
const enums: Record<string, readonly unknown[]> = {
 schemaVersion: [1, 2], method: ['GET', 'HEAD'], terminal: ['finish', 'abort'],
 abortReason: [null, 'client_disconnected', 'request_timeout'],
 paymentStage: ['none', 'quote', 'submitted', 'settled', 'rejected', 'unknown'],
 paymentHeader: ['none', 'payment-signature', 'x-payment', 'both'], protocolVersion: ['none', 'v1', 'v2', 'unknown'],
 paymentPhase: paymentPhases, paymentReason: [null, ...paymentReasons], paymentSubmitted: [true, false], settlementConfirmed: [true, false],
};
const patterns: Record<string, RegExp> = {
 verifiedPayer: /^0x[0-9a-f]{40}$/i, settlementTransaction: /^0x[0-9a-f]{64}$/i,
 settlementAmount: /^[1-9]\d{0,77}$/, settlementAsset: /^0x[0-9a-f]{40}$/i, settlementNetwork: /^eip155:\d{1,10}$/,
};
/** Field and value allowlists: arbitrary strings, client data and signed headers never reach disk. */
function sanitize(row: Row, id: string): Row {
 const output: Row = { requestId: id };
 for (const [key, choices] of Object.entries(enums)) if (key in row) output[key] = choices.includes(row[key]) ? row[key] : '[invalid]';
 for (const [key, pattern] of Object.entries(patterns)) if (key in row) output[key] = row[key] === null ? null : typeof row[key] === 'string' && pattern.test(row[key]) ? row[key] : '[invalid]';
 for (const key of ['status', 'facilitatorVerifyCalls', 'facilitatorSettleCalls', 'facilitatorVerifyMs', 'facilitatorSettleMs']) {
  if (key in row) output[key] = Number.isSafeInteger(row[key]) && Number(row[key]) >= 0 ? row[key] : null;
 }
 if ('t' in row) output.t = date(row.t) ? row.t : null;
 const route = canonicalRoute(typeof (row.route ?? row.path) === 'string' ? String(row.route ?? row.path) : '');
 output.route = routes.has(route) ? route : '[invalid]';
 return output;
}
function validate(value: unknown): asserts value is UsageArchive {
 if (!object(value) || Object.keys(value).sort().join() !== 'collectedAt,entries,startedAt,version' || value.version !== 1 ||
  !date(value.startedAt) || !date(value.collectedAt) || Date.parse(value.startedAt) > Date.parse(value.collectedAt) ||
  !Array.isArray(value.entries) || value.entries.length > ARCHIVE_LIMITS.maxEntries || Buffer.byteLength(JSON.stringify(value)) > ARCHIVE_LIMITS.maxBytes) throw new Error('Invalid archive state');
 const ids = new Set<string>();
 for (const entry of value.entries) {
  if (!object(entry) || Object.keys(entry).sort().join() !== 'conflict,digest,firstSeen,id,row' ||
   typeof entry.id !== 'string' || !digestPattern.test(entry.id) || ids.has(entry.id) || typeof entry.digest !== 'string' || !digestPattern.test(entry.digest) ||
   !date(entry.firstSeen) || Date.parse(entry.firstSeen) > Date.parse(value.collectedAt) || typeof entry.conflict !== 'boolean' || !object(entry.row) ||
   JSON.stringify(sanitize(entry.row, entry.id)) !== JSON.stringify(entry.row)) throw new Error('Invalid archive entry');
  ids.add(entry.id);
 }
}
/** Pure update; caller commits state and report together only after collection succeeds. */
export function updateUsageArchive(previous: unknown, input: string, now: string) {
 if (!date(now) || Buffer.byteLength(input) > ARCHIVE_LIMITS.maxBytes) throw new Error('Invalid time or oversized archive input');
 if (previous !== null) validate(previous);
 const old = previous as UsageArchive | null;
 const ms = Date.parse(now), cutoff = ms - ARCHIVE_LIMITS.retentionDays * DAY;
 if (old && Date.parse(old.collectedAt) > ms) throw new Error('Collection clock moved backwards');
 const entries = new Map<string, Entry>((old?.entries ?? []).filter(e => Date.parse(e.firstSeen) >= cutoff).map(e => [e.id, structuredClone(e)]));
 let ignoredLines = 0;
 for (const line of input.split(/\r?\n/)) {
  if (!line.trim()) continue;
  if (Buffer.byteLength(line) > ARCHIVE_LIMITS.maxLineBytes) throw new Error('Oversized log line');
  let row: unknown;
  try { row = JSON.parse(line); if (object(row) && typeof row.message === 'string') row = JSON.parse(row.message); } catch { ignoredLines++; continue; }
  if (!object(row) || typeof row.requestId !== 'string' || !/^[\w-]{1,128}$/.test(row.requestId)) { ignoredLines++; continue; }
  if (date(row.t) && (Date.parse(row.t) < cutoff || Date.parse(row.t) > ms)) { ignoredLines++; continue; }
  const id = hash(row.requestId), digest = hash(JSON.stringify(row)), safe = sanitize(row, id);
  const existing = entries.get(id);
  // Routine successful probes are not paid-route evidence. Keep a conflicting
  // variant when an ID is already retained, but do not archive probe traffic.
  if (!existing && canonicalRoute(String(row.route ?? row.path ?? '')) === '/api/health' &&
   row.status === 200 && row.paymentHeader === 'none' && row.paymentSubmitted === false &&
   row.paymentStage === 'none' && !row.verifiedPayer && !row.settlementTransaction) { ignoredLines++; continue; }
  if (existing) {
   existing.conflict ||= existing.digest !== digest;
   // Preserve a relevant representative even if the first variant was malformed.
   if (!summarizeUsageLogs(JSON.stringify(existing.row)).input.matchingRecords && summarizeUsageLogs(JSON.stringify(safe)).input.matchingRecords) existing.row = safe;
  } else entries.set(id, { id, digest, firstSeen: now, conflict: false, row: safe });
  if (entries.size > ARCHIVE_LIMITS.maxEntries) throw new Error('Archive entry limit exceeded');
 }
 const state: UsageArchive = { version: 1, startedAt: old?.startedAt ?? now, collectedAt: now, entries: [...entries.values()] };
 if (Buffer.byteLength(JSON.stringify(state)) > ARCHIVE_LIMITS.maxBytes) throw new Error('Archive byte limit exceeded');
 const records = state.entries.flatMap(e => e.conflict ? [JSON.stringify(e.row), JSON.stringify({ requestId: e.id, archiveConflict: true })] : [JSON.stringify(e.row)]);
 const summary = summarizeUsageLogs(records);
 const report = { ...summary, coverage: {
  complete: false, retainedSince: summary.window.firstRequestAt, collectionStartedAt: state.startedAt, collectedAt: now,
  previousCollectionAt: old?.collectedAt ?? null, delayedCollection: !!old && ms - Date.parse(old.collectedAt) > 10 * 60_000,
  ignoredLinesThisCollection: ignoredLines, limits: ARCHIVE_LIMITS,
  warning: 'Best-effort retained observations only. Rotation, deletion and container replacement between polls can lose logs. Conflicts and receipt deduplication apply only within retained records. Empty periods are not proof of zero activity.',
 } };
 return { state, report };
}

