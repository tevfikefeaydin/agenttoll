import { diffReports, reportEvidenceKey, type ChangedCheck } from './research-model.js';
import type { ResearchStore } from './research-store.js';

export type DigestState = 'no-inspections' | 'missing-date' | 'conflict' | 'one-observation' | 'unchanged' | 'changed';
export interface DigestEntry {
  token: string;
  name: string;
  state: DigestState;
  beforeAt: string | null;
  afterAt: string | null;
  evidenceLost: boolean;
  newRisk: boolean;
  changes: ChangedCheck[];
}
/** Saved inspections only: browser save times, examples and sender-supplied snapshots never establish freshness. */
export function buildResearchDigest(store: ResearchStore): DigestEntry[] {
  return store.watchlist.map(watch => {
    const reports = store.reports.filter(r => r.token === watch.token && r.origin === 'inspection');
    const dated = reports.filter(r => r.data.at !== null).sort((a, b) => b.data.at!.localeCompare(a.data.at!));
    const entry: DigestEntry = { token: watch.token, name: dated[0]?.data.symbol || dated[0]?.data.name || watch.label || watch.token,
      state: 'no-inspections', beforeAt: null, afterAt: dated[0]?.data.at ?? null, evidenceLost: false, newRisk: false, changes: [] };
    if (!reports.length) return entry;
    if (dated.length !== reports.length) return { ...entry, state: 'missing-date' as const };
    const observations = new Map<string, typeof dated[number]>();
    for (const report of dated) {
      const previous = observations.get(report.data.at!);
      if (previous && reportEvidenceKey(previous.data) !== reportEvidenceKey(report.data)) return { ...entry, state: 'conflict' as const };
      observations.set(report.data.at!, report);
    }
    const unique = [...observations.values()];
    if (unique.length < 2) return { ...entry, state: 'one-observation' as const };
    const [after, before] = unique;
    const diff = diffReports(before.data, after.data);
    const sourceLoss = before.data.sources.some(source => !after.data.sources.includes(source)) || Object.entries(before.data.sourceStatus).some(([name, source]) =>
      (source.status === 'ok' && after.data.sourceStatus[name]?.status !== 'ok') ||
      (source.status === 'partial' && !['ok', 'partial'].includes(after.data.sourceStatus[name]?.status ?? '')));
    return { ...entry, state: diff.changes.length || sourceLoss ? 'changed' as const : 'unchanged' as const,
      beforeAt: before.data.at, evidenceLost: sourceLoss || diff.changes.some(c => c.evidenceLost),
      newRisk: diff.changes.some(c => c.after.status === 'fail' && c.before.status !== 'fail' || c.after.status === 'warn' && c.before.status === 'pass'),
      changes: diff.changes };
  }).sort((a, b) => Number(b.evidenceLost) - Number(a.evidenceLost) || Number(b.newRisk) - Number(a.newRisk));
}
