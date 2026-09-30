import { normalizeReportDate, normalizeToken } from './research-model.js';

export interface DiscoveryPool {
  name: string;
  pool: string | null;
  token: string | null;
  createdAt: string | null;
  priceUsd: number | null;
  volume24hUsd: number | null;
  liquidityUsd: number | null;
}
export interface Discovery {
  at: string | null;
  source: string | null;
  minLiquidityUsd: number | null;
  count: number | null;
  pools: DiscoveryPool[];
  partial: boolean;
  notes: string[];
}
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const label = (v: unknown, length: number) => typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, length) : '';
const amount = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
const address = (v: unknown) => { try { return normalizeToken(v); } catch { return null; } };

/** Whitelist display evidence. A pool address is never a fallback for token attribution. */
export function parseDiscovery(value: unknown): Discovery {
  if (!record(value) || value.chain !== 'base') throw new Error('The discovery response is not for Base. Received data remains available below.');
  if (!Array.isArray(value.pools) || value.pools.length > 500) throw new Error('The discovery pool list is malformed or oversized. Received data remains available below.');
  const at = normalizeReportDate(value.at);
  const source = label(value.source, 120) || null;
  const notes = ['This is a filtered, ranked provider listing, not all Base launches. Provider pagination and indexing can omit pools.'];
  if (!at) notes.push('Observation time is unavailable; freshness cannot be established.');
  if (!source) notes.push('The provider source is unavailable.');
  let incomplete = false;
  const pools: DiscoveryPool[] = [];
  for (const row of value.pools.slice(0, 30)) {
    if (!record(row)) { incomplete = true; continue; }
    const pool: DiscoveryPool = { name: label(row.name, 180) || 'Unnamed pool', pool: address(row.pool), token: address(row.token),
      createdAt: normalizeReportDate(row.createdAt), priceUsd: amount(row.priceUsd), volume24hUsd: amount(row.volume24hUsd), liquidityUsd: amount(row.liquidityUsd) };
    if (Object.values(pool).some(v => v === null)) incomplete = true;
    pools.push(pool);
  }
  const count = amount(value.count);
  if (incomplete) notes.push('Some rows, token addresses, dates or market values are unavailable. Missing values are unknown.');
  if (value.pools.length > 30) notes.push('Only the first 30 pool rows are displayed.');
  if (count === null || !Number.isSafeInteger(count) || count !== pools.length) notes.push('Reported pool count is missing or differs from the displayed rows.');
  if (source === 'geckoterminal-recent-volume') notes.push('Fallback source: recent pools selected from the volume listing.');
  const note = label(value.note, 1000);
  if (note) notes.push(note);
  // Even a well-formed response is only a sample: this API does not assert exhaustive coverage.
  return { at, source, minLiquidityUsd: amount(value.minLiquidityUsd), count: count !== null && Number.isSafeInteger(count) ? count : null, pools, partial: true, notes };
}
