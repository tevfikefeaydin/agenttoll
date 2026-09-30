import type { Receipt } from './settlement-report.js';

export type RequestActivity = { route: string; day: string; quote: boolean; signed: boolean; failure: boolean };
const weekOf = (day: string) => {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
  return date.toISOString().slice(0, 10);
};
const previousWeek = (week: string) => new Date(Date.parse(`${week}T00:00:00Z`) - 7 * 86_400_000).toISOString().slice(0, 10);
const usdc = (units: bigint) => `${units / 1_000_000n}.${(units % 1_000_000n).toString().padStart(6, '0')}`;

function totals(receipts: readonly Receipt[]) {
  const units = receipts.reduce((sum, receipt) => sum + receipt.amount, 0n);
  return { settlements: receipts.length, deliveredResponses: receipts.filter(row => row.delivery === 'delivered').length,
    settledButAborted: receipts.filter(row => row.delivery === 'aborted').length,
    wallets: new Set(receipts.map(row => row.payer)).size, usdcUnits: units.toString(), usdc: usdc(units) };
}

/** Receipts have already been validated, globally deduplicated and restricted to mainnet. */
export function buildUsageBreakdown(activity: readonly RequestActivity[], receipts: readonly Receipt[]) {
  function group(select: (row: { day: string; route: string }) => string) {
    const buckets = new Map<string, { activity: RequestActivity[]; receipts: Receipt[] }>();
    const bucket = (key: string) => {
      if (!buckets.has(key)) buckets.set(key, { activity: [], receipts: [] });
      return buckets.get(key)!;
    };
    for (const row of activity) bucket(select(row)).activity.push(row);
    for (const row of receipts) bucket(select(row)).receipts.push(row);
    return [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, rows]) => ({ key,
      quotes: rows.activity.filter(row => row.quote).length,
      signedSubmissions: rows.activity.filter(row => row.signed).length,
      signedFailures: rows.activity.filter(row => row.failure).length,
      external: totals(rows.receipts.filter(row => !row.operator)),
      knownOperator: totals(rows.receipts.filter(row => row.operator)),
    }));
  }
  const weekWallets = new Map<string, Set<string>>();
  for (const row of receipts.filter(row => !row.operator)) {
    const week = weekOf(row.day);
    if (!weekWallets.has(week)) weekWallets.set(week, new Set());
    weekWallets.get(week)!.add(row.payer);
  }
  return {
    daily: group(row => row.day).map(({ key, ...row }) => ({ date: key, ...row })),
    byEndpoint: group(row => row.route).map(({ key, ...row }) => ({ route: key, ...row })),
    weekly: group(row => weekOf(row.day)).map(({ key, ...row }) => ({ weekStarting: key, ...row,
      returningFromPreviousWeek: [...(weekWallets.get(key) ?? [])].filter(payer => weekWallets.get(previousWeek(key))?.has(payer)).length,
    })),
  };
}
