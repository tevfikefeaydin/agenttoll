import { inspectionEndpoint } from './token-report.js';

export const CHECK_DEFINITIONS = [
  { id: 'honeypot', title: 'Buying and selling' },
  { id: 'taxes', title: 'Trading taxes' },
  { id: 'verified', title: 'Contract source' },
  { id: 'owner-powers', title: 'Owner permissions' },
  { id: 'concentration', title: 'Holder concentration' },
  { id: 'liquidity', title: 'Liquidity ownership' },
  { id: 'creator-stake', title: 'Creator holdings' },
  { id: 'deployer', title: 'Who deployed it' },
] as const;
export type CheckId = typeof CHECK_DEFINITIONS[number]['id'];
export type CheckStatus = 'pass' | 'warn' | 'fail' | 'unknown';
export type ReportVerdict = 'high-risk' | 'caution' | 'insufficient-data' | 'clear';
export interface CanonicalCheck {
  id: CheckId;
  status: CheckStatus;
  complete: boolean;
  detail: string;
  missing: string[];
  conflicts: string[];
  sources: string[];
}
export interface CheckSummary extends CanonicalCheck { title: string }
export interface CanonicalSource {
  status: 'ok' | 'partial' | 'not-found' | 'unavailable' | 'invalid';
  fetchedAt: string | null;
  issues: string[];
}
/** Only displayable report evidence. Never put receipts, request IDs, or wallet data here. */
export interface CanonicalReport {
  chain: 'base';
  token: string;
  name: string;
  symbol: string;
  at: string | null;
  checks: CanonicalCheck[];
  holderCount: number | null;
  sources: string[];
  sourceStatus: Record<string, CanonicalSource>;
}
export interface ReportSummary {
  token: string;
  name: string;
  symbol: string;
  at: string | null;
  checks: CheckSummary[];
  flags: number;
  warnings: number;
  completed: number;
  verdict: ReportVerdict;
}
export type ChangedCheckField = 'status' | 'complete' | 'detail' | 'missing' | 'conflicts' | 'sources';
export interface ChangedCheck {
  id: CheckId;
  title: string;
  before: CheckSummary;
  after: CheckSummary;
  fields: ChangedCheckField[];
  evidenceLost: boolean;
}
export interface ReportDiff {
  token: string;
  before: ReportSummary;
  after: ReportSummary;
  sameObservation: boolean;
  comparable: boolean;
  changes: ChangedCheck[];
  warnings: string[];
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const boundedText = (value: unknown, limit: number, fallback = ''): string =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, limit).trim() : fallback;

export function normalizeToken(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Enter a Base token contract address.');
  return inspectionEndpoint(value).split('/').at(-1)!;
}

/** Require an unambiguous, calendar-valid timestamp; a save date is never an observation date. */
export function normalizeReportDate(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 40) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match.map(Number);
  if (year < 1000 || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return null;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day > daysInMonth) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function evidenceList(value: unknown): { values: string[]; invalid: boolean } {
  if (value === undefined) return { values: [], invalid: false };
  if (!Array.isArray(value)) return { values: [], invalid: true };
  let invalid = value.length > 30;
  const values: string[] = [];
  for (const item of value.slice(0, 30)) {
    if (typeof item !== 'string' || !item.trim()) { invalid = true; continue; }
    if (item.length > 160) invalid = true;
    values.push(item.trim().slice(0, 160).trim());
  }
  return { values: [...new Set(values)].sort(), invalid };
}

function markEvidence(values: string[], marker: string): void {
  if (values.includes(marker)) return;
  // Keep canonical arrays within the same bound used when they are reloaded or shared again.
  values.splice(29);
  values.push(marker);
}

function sanitizeCheck(id: CheckId, matches: Record<string, unknown>[]): CanonicalCheck {
  const check = matches.length === 1 ? matches[0] : {};
  let status: CheckStatus = check.status === 'pass' || check.status === 'warn' || check.status === 'fail' ? check.status : 'unknown';
  const missing = evidenceList(check.missing);
  const conflicts = evidenceList(check.conflicts);
  const sources = evidenceList(check.sources);
  if (matches.length > 1) markEvidence(missing.values, 'duplicate-check');
  if (missing.invalid || conflicts.invalid || sources.invalid) markEvidence(missing.values, 'malformed-check-evidence');
  const complete = check.complete === true && status !== 'unknown' && !missing.values.length && !conflicts.values.length;
  // Same conservative rule as renderTokenReport: incomplete passes are unknown, conflicts are warnings.
  if (status === 'pass' && !complete) status = conflicts.values.length ? 'warn' : 'unknown';
  return { id, status, complete, detail: boundedText(check.detail, 2000, 'This check is not available.'),
    missing: [...new Set(missing.values)].sort(), conflicts: conflicts.values, sources: sources.values };
}

export function sanitizeReport(value: unknown, expectedToken?: string): CanonicalReport {
  const data = record(value);
  if (data.chain !== 'base') throw new Error('The response is not a Base token report.');
  const token = normalizeToken(data.token);
  if (expectedToken !== undefined && normalizeToken(expectedToken) !== token) throw new Error('The report is for a different token.');
  if (Array.isArray(data.checks) && data.checks.length > 128) throw new Error('The report has too many check entries.');
  const supplied = Array.isArray(data.checks) ? data.checks.map(record) : [];
  const checks = CHECK_DEFINITIONS.map(({ id }) => sanitizeCheck(id, supplied.filter(check => check.id === id)));
  const symbol = boundedText(data.symbol, 80);
  const sourceStatus: Record<string, CanonicalSource> = {};
  const rawSources = record(data.sourceStatus);
  // These are the providers currently emitted by the safety API; no arbitrary metadata keys survive.
  for (const name of ['blockscout+rpc', 'fresh+rpc', 'goplus', 'goplus+rpc', 'honeypot.is']) {
    if (!Object.hasOwn(rawSources, name)) continue;
    const source = record(rawSources[name]);
    const status = source.status === 'ok' || source.status === 'partial' || source.status === 'not-found' || source.status === 'invalid'
      ? source.status : 'unavailable';
    const issues = evidenceList(source.issues);
    if (issues.invalid) markEvidence(issues.values, 'malformed-source-evidence');
    sourceStatus[name] = { status: issues.invalid && status === 'ok' ? 'partial' : status,
      fetchedAt: normalizeReportDate(source.fetchedAt), issues: [...new Set(issues.values)].sort() };
  }
  return { chain: 'base', token, name: boundedText(data.name, 200, symbol || 'Token report'), symbol,
    at: normalizeReportDate(data.at), checks,
    holderCount: typeof data.holderCount === 'number' && Number.isSafeInteger(data.holderCount) && data.holderCount >= 0 ? data.holderCount : null,
    sources: evidenceList(data.sources).values, sourceStatus };
}

export function summarizeReport(value: unknown, expectedToken?: string): ReportSummary {
  const data = sanitizeReport(value, expectedToken);
  const checks = data.checks.map((check, index) => ({ ...check, title: CHECK_DEFINITIONS[index].title }));
  const flags = checks.filter(check => check.status === 'fail').length;
  const warnings = checks.filter(check => check.status === 'warn').length;
  const completed = checks.filter(check => check.complete).length;
  return { token: data.token, name: data.name, symbol: data.symbol, at: data.at, checks, flags, warnings, completed,
    verdict: flags ? 'high-risk' : warnings ? 'caution' : completed < checks.length ? 'insufficient-data' : 'clear' };
}

/** Stable observation content, excluding retrieval timestamps. The report must already be canonical. */
export function reportEvidenceKey(report: CanonicalReport): string {
  return JSON.stringify({ ...report, sourceStatus: Object.fromEntries(Object.entries(report.sourceStatus)
    .map(([name, source]) => [name, { status: source.status, issues: source.issues }])) });
}

export function diffReports(beforeValue: unknown, afterValue: unknown): ReportDiff {
  const beforeReport = sanitizeReport(beforeValue);
  const afterReport = sanitizeReport(afterValue, beforeReport.token);
  const before = summarizeReport(beforeReport);
  const after = summarizeReport(afterReport);
  const sameObservation = before.at !== null && before.at === after.at;
  const warnings: string[] = [];
  const comparable = before.at !== null && after.at !== null && after.at > before.at;
  if (sameObservation) {
    warnings.push(reportEvidenceKey(beforeReport) === reportEvidenceKey(afterReport)
      ? 'These reports contain the same dated observation. A cached report is not a fresh check.'
      : 'These reports have the same observation time but different content. Treat this as conflicting snapshots, not a fresh check.');
  } else if (!before.at || !after.at) warnings.push('An observation time is unavailable. Changes over time cannot be established.');
  else if (!comparable) warnings.push('The second report predates the first. Choose the earlier observation first.');
  const changes: ChangedCheck[] = [];
  if (comparable) {
    for (let index = 0; index < before.checks.length; index++) {
      const previous = before.checks[index];
      const next = after.checks[index];
      const fields = (['status', 'complete', 'detail', 'missing', 'conflicts', 'sources'] as const)
        .filter(field => JSON.stringify(previous[field]) !== JSON.stringify(next[field]));
      if (!fields.length) continue;
      changes.push({ id: previous.id, title: previous.title, before: previous, after: next, fields,
        evidenceLost: (previous.complete && !next.complete) || (previous.status !== 'unknown' && next.status === 'unknown')
          || next.missing.some(item => !previous.missing.includes(item))
          || previous.sources.some(source => !next.sources.includes(source)) });
    }
  }
  return { token: before.token, before, after, sameObservation, comparable, changes, warnings };
}
