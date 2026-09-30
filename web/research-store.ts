import { normalizeReportDate, normalizeToken, reportEvidenceKey, sanitizeReport, type CanonicalReport } from './research-model.js';

export const RESEARCH_STORAGE_KEY = 'agenttoll.research.v1';
export const MAX_WATCHLIST = 50;
export const MAX_REPORTS = 100;
export const MAX_REPORTS_PER_TOKEN = 10;
/** Conservative UTF-16 budget, including JSON syntax, suitable for localStorage. */
export const MAX_STORAGE_BYTES = 2 * 1024 * 1024;
export type ReportOrigin = 'inspection' | 'example' | 'shared';
export interface WatchItem { token: string; addedAt: string; label?: string }
export interface SavedReport { id: string; token: string; savedAt: string; origin: ReportOrigin; data: CanonicalReport }
export interface ResearchStore { version: 1; watchlist: WatchItem[]; reports: SavedReport[] }
export interface StorageLike { getItem(key: string): string | null; setItem(key: string, value: string): void }
export interface StoreReadResult { store: ResearchStore; warnings: string[]; writable: boolean }
export interface StoreWriteResult extends StoreReadResult { saved: boolean }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const isOrigin = (value: unknown): value is ReportOrigin => value === 'inspection' || value === 'example' || value === 'shared';
const labelText = (value: unknown) => typeof value === 'string' ? value.trim().slice(0, 200).trim() : '';
// Equal evidence from different origins does not make those snapshots interchangeable.
const snapshotKey = (data: CanonicalReport, origin: ReportOrigin) => `${origin}:${reportEvidenceKey(data)}`;

export function emptyResearchStore(): ResearchStore { return { version: 1, watchlist: [], reports: [] }; }
/** Pure reset; persisting it still observes the adapter's corrupt/future-version guard. */
export function clearResearchStore(): ResearchStore { return emptyResearchStore(); }

function requireDate(value: unknown): string {
  const date = normalizeReportDate(value);
  if (!date) throw new Error('A valid date with a timezone is required.');
  return date;
}

function contentId(key: string, used: Set<string>): string {
  // IDs are selectors, not signatures or authenticity claims. Dedupe compares the full key below.
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < key.length; index++) {
    first = Math.imul(first ^ key.charCodeAt(index), 0x01000193);
    second = Math.imul(second ^ key.charCodeAt(index), 0x85ebca6b);
  }
  const base = `r-${(first >>> 0).toString(16)}-${(second >>> 0).toString(16)}`;
  let id = base;
  for (let suffix = 1; used.has(id); suffix++) id = `${base}-${suffix}`;
  return id;
}

const historyTime = (report: SavedReport) => report.data.at || report.savedAt;
function retain(store: ResearchStore): ResearchStore {
  const counts = new Map<string, number>();
  const reports = [...store.reports].sort((a, b) => historyTime(b).localeCompare(historyTime(a)) || b.savedAt.localeCompare(a.savedAt))
    .filter(report => {
      const count = counts.get(report.token) || 0;
      if (count >= MAX_REPORTS_PER_TOKEN) return false;
      counts.set(report.token, count + 1);
      return true;
    }).slice(0, MAX_REPORTS);
  const result: ResearchStore = { version: 1, watchlist: store.watchlist.slice(0, MAX_WATCHLIST), reports };
  while (result.reports.length && JSON.stringify(result).length * 2 > MAX_STORAGE_BYTES) result.reports.pop();
  return result;
}

/** Validate reloaded data as strictly as fresh reports. Partial v1 recovery is visible to the caller. */
function validateStore(value: unknown): { store: ResearchStore; warnings: string[] } {
  if (!isRecord(value) || value.version !== 1) throw new Error('Saved research has an unsupported or invalid version. Clear saved research to start over.');
  if (!Array.isArray(value.watchlist) || !Array.isArray(value.reports)) throw new Error('Saved research is malformed. Clear saved research to start over.');
  if (value.watchlist.length > 500 || value.reports.length > 1000) throw new Error('Saved research contains too many entries. Clear saved research to start over.');
  const store = emptyResearchStore();
  const tokens = new Set<string>();
  const keys = new Set<string>();
  const ids = new Set<string>();
  let discarded = 0;
  let repaired = false;
  for (const entry of value.watchlist) {
    try {
      if (!isRecord(entry)) throw new Error('Invalid saved token');
      const token = normalizeToken(entry.token);
      const addedAt = requireDate(entry.addedAt);
      if (tokens.has(token)) { discarded++; continue; }
      const label = labelText(entry.label);
      store.watchlist.push({ token, addedAt, ...(label ? { label } : {}) });
      tokens.add(token);
    } catch { discarded++; }
  }
  for (const entry of value.reports) {
    try {
      if (!isRecord(entry) || !isOrigin(entry.origin)) throw new Error('Invalid saved report');
      const token = normalizeToken(entry.token);
      const savedAt = requireDate(entry.savedAt);
      const data = sanitizeReport(entry.data, token);
      const key = snapshotKey(data, entry.origin);
      if (keys.has(key)) { discarded++; continue; }
      let id = typeof entry.id === 'string' && /^[a-z0-9][a-z0-9_-]{0,95}$/i.test(entry.id) ? entry.id : '';
      if (!id || ids.has(id)) { id = contentId(key, ids); repaired = true; }
      store.reports.push({ id, token, savedAt, origin: entry.origin, data });
      keys.add(key);
      ids.add(id);
    } catch { discarded++; }
  }
  const bounded = retain(store);
  const trimmed = bounded.watchlist.length < store.watchlist.length || bounded.reports.length < store.reports.length;
  const warnings: string[] = [];
  if (discarded || repaired) warnings.push('Some invalid or duplicate saved entries were omitted or repaired. The valid research entries remain available.');
  if (trimmed) warnings.push('Saved research exceeded this browser library’s limits. Only the most recent bounded report history is shown.');
  return { store: bounded, warnings };
}

export function addWatch(store: ResearchStore, value: unknown, label?: string, at = new Date().toISOString()): ResearchStore {
  const next = validateStore(store).store;
  const token = normalizeToken(value);
  const addedAt = requireDate(at);
  if (next.watchlist.some(item => item.token === token)) return next;
  if (next.watchlist.length >= MAX_WATCHLIST) throw new Error('The saved-token list is full (50 tokens). Remove a token before adding another.');
  const cleanLabel = labelText(label);
  return { ...next, watchlist: [...next.watchlist, { token, addedAt, ...(cleanLabel ? { label: cleanLabel } : {}) }] };
}

export function removeWatch(store: ResearchStore, value: unknown): ResearchStore {
  const next = validateStore(store).store;
  const token = normalizeToken(value);
  return { ...next, watchlist: next.watchlist.filter(item => item.token !== token) };
}

export function saveReport(store: ResearchStore, value: unknown, origin: ReportOrigin, at = new Date().toISOString()): ResearchStore {
  const next = validateStore(store).store;
  if (!isOrigin(origin)) throw new Error('Choose a valid report source.');
  const data = sanitizeReport(value);
  const savedAt = requireDate(at);
  const key = snapshotKey(data, origin);
  if (next.reports.some(report => snapshotKey(report.data, report.origin) === key)) return next;
  const id = contentId(key, new Set(next.reports.map(report => report.id)));
  return retain({ ...next, reports: [{ id, token: data.token, savedAt, origin, data }, ...next.reports] });
}

export function removeReport(store: ResearchStore, id: string): ResearchStore {
  const next = validateStore(store).store;
  return { ...next, reports: next.reports.filter(report => report.id !== id) };
}

function reconcileItems<T>(base: T[], local: T[], remote: T[], identity: (item: T) => string, content: (item: T) => string): T[] {
  const baseline = new Map(base.map(item => [identity(item), item]));
  const pending = new Map(local.map(item => [identity(item), item]));
  const current = new Map(remote.map(item => [identity(item), item]));
  for (const key of baseline.keys()) {
    if (!pending.has(key)) current.delete(key);
  }
  const changed: T[] = [];
  for (const [key, item] of pending) {
    if (!baseline.has(key) || content(item) !== content(baseline.get(key)!)) {
      current.delete(key);
      changed.push(item);
    }
  }
  // Local edits take precedence if both tabs changed the same identity. Unchanged local
  // entries are never replayed, so they cannot undo another tab's edit or removal.
  return [...changed, ...current.values()];
}

/**
 * Replay page-only changes since the last observed disk baseline onto current disk data.
 * Inputs are validated and cloned. Report IDs are selectors, not merge identities.
 * Existing history/byte retention still applies; local watch edits precede remote items
 * when concurrent additions exceed the watchlist's capacity.
 */
export function reconcileResearchStore(base: ResearchStore, local: ResearchStore, remote: ResearchStore): ResearchStore {
  const baseline = validateStore(base).store;
  const pending = validateStore(local).store;
  const current = validateStore(remote).store;
  const watchlist = reconcileItems(baseline.watchlist, pending.watchlist, current.watchlist,
    item => item.token, item => JSON.stringify(item));
  const reports = reconcileItems(baseline.reports, pending.reports, current.reports,
    item => snapshotKey(item.data, item.origin), item => JSON.stringify({ savedAt: item.savedAt, data: item.data }));
  // Revalidate the union to repair any selector collision and apply all storage limits.
  return validateStore({ version: 1, watchlist, reports }).store;
}

function resolveStorage(provided?: StorageLike | null): StorageLike | null {
  if (provided !== undefined) return provided;
  try { return globalThis.localStorage || null; } catch { return null; }
}

export function readResearchStore(provided?: StorageLike | null): StoreReadResult {
  const storage = resolveStorage(provided);
  if (!storage) return { store: emptyResearchStore(), writable: false, warnings: ['Browser storage is unavailable. Research changes will remain in this page only.'] };
  let raw: string | null;
  try { raw = storage.getItem(RESEARCH_STORAGE_KEY); }
  catch { return { store: emptyResearchStore(), writable: false, warnings: ['Browser storage is blocked. Research changes will remain in this page only.'] }; }
  if (raw === null) return { store: emptyResearchStore(), writable: true, warnings: [] };
  if (typeof raw !== 'string' || raw.length * 2 > MAX_STORAGE_BYTES) {
    return { store: emptyResearchStore(), writable: false, warnings: ['Saved research is too large to load. It was left untouched; clear saved research to start over.'] };
  }
  try { return { ...validateStore(JSON.parse(raw)), writable: true }; }
  catch (error) {
    const warning = error instanceof SyntaxError ? 'Saved research could not be read. It was left untouched; clear saved research to start over.'
      : error instanceof Error ? error.message : 'Saved research is invalid and was left untouched.';
    return { store: emptyResearchStore(), writable: false, warnings: [warning] };
  }
}

export function writeResearchStore(value: ResearchStore, provided?: StorageLike | null): StoreWriteResult {
  const storage = resolveStorage(provided);
  // Read immediately before writing so a new future-version payload is never silently replaced.
  const previous = readResearchStore(storage);
  let validated: ReturnType<typeof validateStore>;
  try { validated = validateStore(value); }
  catch { return { ...previous, saved: false, warnings: [...previous.warnings, 'The research changes are invalid and were not saved.'] }; }
  const warnings = [...new Set([...previous.warnings, ...validated.warnings])];
  if (!storage || !previous.writable) return { store: validated.store, writable: false, saved: false, warnings };
  try {
    // setItem is atomic: never remove earlier data to make space, and never retry with fewer records.
    storage.setItem(RESEARCH_STORAGE_KEY, JSON.stringify(validated.store));
    return { store: validated.store, writable: true, saved: true, warnings };
  } catch (error) {
    const quota = isRecord(error) && (error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED');
    warnings.push(quota ? 'Browser storage is full. These changes were not saved; the previously stored research is still on disk.'
      : 'Browser storage could not save these changes. The previously stored research is still on disk.');
    return { store: validated.store, writable: false, saved: false, warnings };
  }
}
