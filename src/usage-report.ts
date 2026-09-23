import { summarizePaymentLogs } from './settlement-report.js';

/** Mainnet usage across all paid endpoints, without emitting payer identities. */
export function summarizeUsageLogs(input: string | readonly string[], additionalOperatorWallets: readonly string[] = []) {
  const { report, breakdown } = summarizePaymentLogs(input, additionalOperatorWallets, 'usage');
  return { ...report, ...breakdown, notes: [...report.notes,
    'Daily and weekly receipt dates use the earliest supplied log observation, in UTC.',
    'Returning external wallets have receipts on two distinct UTC dates; weekly overlap compares consecutive Monday-start weeks in this export, not customer retention.',
    'Absent days or weeks are not proof of zero activity. Weekly and daily wallet counts must not be summed to obtain unique wallets.',
    'Revenue is gross confirmed USDC, not profit; costs, refunds and unsolicited onchain transfers are not inferred.',
  ] };
}
