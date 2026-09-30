import { summarizePaymentLogs } from './settlement-report.js';

/** Preserve the browser-only report and its existing output contract. */
export function summarizeInspectionLogs(input: string | readonly string[], additionalOperatorWallets: readonly string[] = []) {
  return summarizePaymentLogs(input, additionalOperatorWallets, 'inspection').report;
}
