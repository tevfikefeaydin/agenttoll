import { summarizePaymentLogs, summarizePaymentRows } from './settlement-report.js';

/** Mainnet usage across all paid endpoints, without emitting payer identities. */
export function summarizeUsageLogs(input: string | readonly string[], additionalOperatorWallets: readonly string[] = []) {
  return usageReport(summarizePaymentLogs(input, additionalOperatorWallets, 'usage'));
}

/** Private reporting over a one-pass iterable of parsed JSON log records. */
export function summarizeUsageRows(input: Iterable<Record<string, unknown>>, additionalOperatorWallets: readonly string[] = []) {
  return usageReport(summarizePaymentRows(input, additionalOperatorWallets, 'usage'));
}

function usageReport({ report, breakdown }: ReturnType<typeof summarizePaymentLogs>) {
  return { ...report, ...breakdown, notes: [...report.notes,
    'Daily and weekly receipt dates use the earliest supplied log observation, in UTC.',
    'Returning external wallets have receipts on two distinct UTC dates; weekly overlap compares consecutive Monday-start weeks in this export, not customer retention.',
    'Absent days or weeks are not proof of zero activity. Weekly and daily wallet counts must not be summed to obtain unique wallets.',
    'Revenue is gross confirmed USDC, not profit; costs, refunds and unsolicited onchain transfers are not inferred.',
  ] };
}
