import { ENDPOINT_MANIFEST } from './endpoint-manifest.js';
import { buildUsageBreakdown, type RequestActivity } from './usage-breakdown.js';
import { canonicalRoute } from './telemetry.js';
import { KNOWN_OPERATOR_WALLETS } from './operator-wallets.js';
import { paymentPhases, paymentReasons } from './payment-telemetry.js';

type Row = Record<string, unknown>;
export type Receipt = {
  route: string;
  fingerprint: string;
  network: string;
  payer: string;
  amount: bigint;
  observedAt: number;
  day: string;
  delivery: 'delivered' | 'aborted';
  operator: boolean;
};

const INSPECTION_ROUTE = '/api/base/safety/{address}';
const INSPECTION_CLIENT = 'agenttoll-inspect';
const phases = new Set<string>(paymentPhases);
const reasons = new Set<string>(paymentReasons);
const stages = new Set(['none', 'quote', 'submitted', 'settled', 'rejected', 'unknown']);
const USDC_BY_NETWORK: Readonly<Record<string, string>> = {
  'eip155:8453': '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  'eip155:84532': '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
};
const address = (value: unknown) => typeof value === 'string' && /^0x[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : null;
const transaction = (value: unknown) => typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value) ? value.toLowerCase() : null;
const increment = (target: Record<string, number>, key: string) => { target[key] = (target[key] ?? 0) + 1; };

function parseLine(line: string): Row | null {
  if (line.length > 65_536) return null;
  try {
    let row = JSON.parse(line);
    if (typeof row?.message === 'string') row = JSON.parse(row.message);
    return row && typeof row === 'object' && !Array.isArray(row) ? row : null;
  } catch { return null; }
}

const paidRoutes = new Set<string>(ENDPOINT_MANIFEST.map(endpoint => endpoint.path));
function validCore(row: Row, scope: 'inspection' | 'usage'): boolean {
  const client = row.client as Row | null;
  return (row.schemaVersion === 1 || row.schemaVersion === 2) &&
    typeof row.requestId === 'string' && /^[\w-]{1,128}$/.test(row.requestId) &&
    typeof row.t === 'string' && Number.isFinite(Date.parse(row.t)) &&
    ['GET', 'HEAD'].includes(String(row.method)) &&
    Number.isInteger(row.status) && Number(row.status) >= 100 && Number(row.status) <= 599 &&
    stages.has(String(row.paymentStage)) && typeof row.paymentSubmitted === 'boolean' &&
    (scope === 'usage' ? paidRoutes.has(canonicalRoute(String(row.route ?? row.path ?? ''))) :
    Boolean(client && client.name === INSPECTION_CLIENT && client.source === 'x-agenttoll-client' &&
      typeof client.version === 'string' && /^\d{1,4}\.\d{1,4}(?:\.\d{1,4})?$/.test(client.version)) &&
    canonicalRoute(String(row.route ?? row.path ?? '')) === INSPECTION_ROUTE);
}

function consistentV2(row: Row): boolean {
  return row.schemaVersion === 2 && ['finish', 'abort'].includes(String(row.terminal)) &&
    phases.has(String(row.paymentPhase)) && (row.paymentReason === null || reasons.has(String(row.paymentReason))) &&
    ['none', 'payment-signature', 'x-payment', 'both'].includes(String(row.paymentHeader)) &&
    ['none', 'v1', 'v2', 'unknown'].includes(String(row.protocolVersion)) &&
    ['facilitatorVerifyCalls', 'facilitatorSettleCalls', 'facilitatorVerifyMs', 'facilitatorSettleMs']
      .every(key => Number.isSafeInteger(row[key]) && Number(row[key]) >= 0) &&
    (row.terminal === 'abort'
      ? row.status === 499 && ['client_disconnected', 'request_timeout'].includes(String(row.abortReason))
      : row.abortReason === null);
}

function usdc(units: bigint): string {
  const whole = units / 1_000_000n;
  return `${whole}.${(units % 1_000_000n).toString().padStart(6, '0')}`;
}

/** Shared validation and deduplication for private application-log reports. */
export function summarizePaymentLogs(input: string | readonly string[], additionalOperatorWallets: readonly string[] = [], scope: 'inspection' | 'usage' = 'inspection') {
  if (additionalOperatorWallets.length > 128) throw new Error('At most 128 additional operator wallets can be excluded.');
  const operatorWallets = new Set(KNOWN_OPERATOR_WALLETS);
  for (const value of additionalOperatorWallets) {
    const normalized = address(value);
    if (!normalized) throw new Error('Excluded operator wallets must be 0x-prefixed 20-byte addresses.');
    operatorWallets.add(normalized);
  }

  const text: string = typeof input === 'string' ? input : input.join('\n');
  const requestGroups = new Map<string, { row: Row; fingerprints: Set<string>; records: number; relevant: boolean }>();
  const rows: Row[] = [];
  let totalLines = 0;
  let ignoredLines = 0;
  let duplicateRequestIds = 0;
  let conflictingRequestIds = 0;
  let conflictingRequestRecords = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    totalLines++;
    const row = parseLine(line);
    if (!row) { ignoredLines++; continue; }
    if (typeof row.requestId !== 'string' || !/^[\w-]{1,128}$/.test(row.requestId)) continue;
    const id = row.requestId;
    const fingerprint = JSON.stringify(row);
    const group = requestGroups.get(id);
    if (group) {
      group.records++;
      group.fingerprints.add(fingerprint);
      group.relevant ||= validCore(row, scope);
    } else requestGroups.set(id, { row, fingerprints: new Set([fingerprint]), records: 1, relevant: validCore(row, scope) });
  }
  for (const group of requestGroups.values()) {
    if (!group.relevant) continue;
    if (group.fingerprints.size > 1) {
      conflictingRequestIds++;
      conflictingRequestRecords += group.records;
      continue;
    }
    if (!validCore(group.row, scope)) continue;
    rows.push(group.row);
    duplicateRequestIds += group.records - 1;
  }

  const times = rows.map(row => Date.parse(row.t as string)).sort((a, b) => a - b);
  const days = new Set(rows.map(row => new Date(row.t as string).toISOString().slice(0, 10)));
  let quotes = 0;
  let signedSubmissions = 0;
  const failureStages: Record<string, number> = {};
  const failurePhases: Record<string, number> = {};
  const failureReasons: Record<string, number> = {};
  let failures = 0;
  const receiptGroups = new Map<string, Receipt[]>();
  const unresolved = {
    totalRecords: 0,
    malformedReceiptRecords: 0,
    unsupportedAssetRecords: 0,
    unsupportedNetworkRecords: 0,
    legacyOrInconsistentRecords: 0,
    conflictingReceipts: 0,
    conflictingReceiptRecords: 0,
  };

  const activity: RequestActivity[] = [];
  for (const row of rows) {
    const validV2 = consistentV2(row);
    const signed = row.paymentSubmitted === true && ['payment-signature', 'both'].includes(String(row.paymentHeader));

    const claimsSettlement = row.paymentStage === 'settled' || row.settlementConfirmed === true ||
      ['settlementTransaction', 'settlementAmount', 'settlementAsset', 'settlementNetwork'].some(key => row[key] !== undefined && row[key] !== null);
    if (!validV2 && !claimsSettlement) continue;
    if (validV2 && row.paymentStage === 'quote' && row.paymentSubmitted === false && row.status === 402 && row.paymentHeader === 'none') quotes++;
    if (validV2 && signed) signedSubmissions++;
    if (validV2) activity.push({ route: canonicalRoute(String(row.route ?? row.path ?? '')),
      day: new Date(row.t as string).toISOString().slice(0, 10),
      quote: row.paymentStage === 'quote' && row.paymentSubmitted === false && row.status === 402 && row.paymentHeader === 'none',
      signed, failure: signed && !claimsSettlement });
    if (!claimsSettlement) {
      if (signed) {
        failures++;
        increment(failureStages, String(row.paymentStage));
        if (phases.has(String(row.paymentPhase))) increment(failurePhases, String(row.paymentPhase));
        if (typeof row.paymentReason === 'string' && reasons.has(row.paymentReason)) increment(failureReasons, row.paymentReason);
      }
      continue;
    }

    const delivered = row.terminal === 'finish' && Number(row.status) >= 200 && Number(row.status) < 300;
    const aborted = row.terminal === 'abort' && row.status === 499 && ['client_disconnected', 'request_timeout'].includes(String(row.abortReason));
    const stateIsConsistent = validV2 && signed && row.protocolVersion === 'v2' && row.paymentPhase === 'settle' &&
      row.paymentStage === 'settled' && (delivered ? row.paymentReason === null : aborted && row.paymentReason === row.abortReason) &&
      row.settlementConfirmed !== false && Number.isSafeInteger(row.facilitatorVerifyCalls) && Number(row.facilitatorVerifyCalls) >= 1 &&
      Number.isSafeInteger(row.facilitatorSettleCalls) && Number(row.facilitatorSettleCalls) >= 1;
    if (!stateIsConsistent || (!delivered && !aborted) || typeof row.settlementAmount !== 'string' || !/^[1-9]\d{0,77}$/.test(row.settlementAmount) ||
      typeof row.settlementAsset !== 'string' || typeof row.settlementNetwork !== 'string') {
      unresolved.legacyOrInconsistentRecords++;
      unresolved.totalRecords++;
      continue;
    }
    const payer = address(row.verifiedPayer);
    const tx = transaction(row.settlementTransaction);
    if (!payer || !tx) {
      unresolved.malformedReceiptRecords++;
      unresolved.totalRecords++;
      continue;
    }
    const network = row.settlementNetwork;
    const expectedAsset = USDC_BY_NETWORK[network];
    if (!expectedAsset) {
      unresolved.unsupportedNetworkRecords++;
      unresolved.totalRecords++;
      continue;
    }
    const asset = address(row.settlementAsset);
    if (!asset || asset !== expectedAsset) {
      unresolved.unsupportedAssetRecords++;
      unresolved.totalRecords++;
      continue;
    }
    const delivery = delivered ? 'delivered' : 'aborted';
    const amount = BigInt(row.settlementAmount);
    const key = `${network}/${asset}/${tx}`;
    const route = canonicalRoute(String(row.route ?? row.path ?? ''));
    const fingerprint = `${payer}/${amount}/${delivery}/${route}`;
    const observedAt = Date.parse(row.t as string);
    const receipt: Receipt = { route, fingerprint, network, payer, amount, observedAt,
      day: new Date(observedAt).toISOString().slice(0, 10),
      delivery, operator: operatorWallets.has(payer) };
    const group = receiptGroups.get(key) ?? [];
    group.push(receipt);
    receiptGroups.set(key, group);
  }

  const accepted: Receipt[] = [];
  let duplicateReceiptRecords = 0;
  for (const group of receiptGroups.values()) {
    if (new Set(group.map(receipt => receipt.fingerprint)).size > 1) {
      unresolved.conflictingReceipts++;
      unresolved.conflictingReceiptRecords += group.length;
      unresolved.totalRecords += group.length;
      continue;
    }
    accepted.push(group.reduce((earliest, receipt) => receipt.observedAt < earliest.observedAt ? receipt : earliest));
    duplicateReceiptRecords += group.length - 1;
  }

  const mainnet = accepted.filter(receipt => receipt.network === 'eip155:8453');
  const testnet = accepted.filter(receipt => receipt.network === 'eip155:84532');
  let totalUnits = 0n;
  let knownOperatorUnits = 0n;
  let externalUnits = 0n;
  const operatorPayers = new Set<string>();
  const externalPayers = new Map<string, Set<string>>();
  for (const receipt of mainnet) {
    totalUnits += receipt.amount;
    if (receipt.operator) {
      knownOperatorUnits += receipt.amount;
      operatorPayers.add(receipt.payer);
    } else {
      externalUnits += receipt.amount;
      const payerDays = externalPayers.get(receipt.payer) ?? new Set<string>();
      payerDays.add(receipt.day);
      externalPayers.set(receipt.payer, payerDays);
    }
  }
  let testnetUnits = 0n;
  const testnetOperatorPayers = new Set<string>();
  const testnetExternalPayers = new Map<string, Set<string>>();
  for (const receipt of testnet) {
    testnetUnits += receipt.amount;
    if (receipt.operator) testnetOperatorPayers.add(receipt.payer);
    else {
      const payerDays = testnetExternalPayers.get(receipt.payer) ?? new Set<string>();
      payerDays.add(receipt.day);
      testnetExternalPayers.set(receipt.payer, payerDays);
    }
  }

  const sorted = (value: Record<string, number>) => Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
  return { breakdown: buildUsageBreakdown(activity, mainnet), report: {
    schemaVersion: 1,
    scope: {
      route: scope === 'inspection' ? INSPECTION_ROUTE : 'all-registered-paid-routes',
      client: scope === 'inspection' ? INSPECTION_CLIENT : 'all-clients',
      description: scope === 'inspection' ? 'Supplied application log records for the allowlisted browser inspection client only.' : 'Supplied application log records for all registered paid endpoints; no client label required.',
    },
    window: {
      firstRequestAt: times.length ? new Date(times[0]).toISOString() : null,
      lastRequestAt: times.length ? new Date(times[times.length - 1]).toISOString() : null,
      utcDaysObserved: days.size,
    },
    input: { totalLines, matchingRecords: rows.length, duplicateRequestIds, conflictingRequestIds, conflictingRequestRecords, ignoredLines },
    requests: { quotes, signedSubmissions },
    failures: { total: failures, byPaymentStage: sorted(failureStages), byPaymentPhase: sorted(failurePhases), byReason: sorted(failureReasons) },
    settlements: {
      network: 'eip155:8453',
      confirmedUnique: mainnet.length,
      successfullyDeliveredReports: mainnet.filter(receipt => receipt.delivery === 'delivered').length,
      settledButAborted: mainnet.filter(receipt => receipt.delivery === 'aborted').length,
      duplicateReceiptRecords,
      unresolved,
      usdc: {
        totalUnits: totalUnits.toString(), total: usdc(totalUnits),
        knownOperatorUnits: knownOperatorUnits.toString(), knownOperator: usdc(knownOperatorUnits),
        externalUnits: externalUnits.toString(), external: usdc(externalUnits),
      },
      wallets: {
        knownOperator: operatorPayers.size,
        external: externalPayers.size,
        returningExternal: [...externalPayers.values()].filter(payerDays => payerDays.size >= 2).length,
      },
      excludedTestnet: {
        network: 'eip155:84532',
        confirmedUnique: testnet.length,
        successfullyDeliveredReports: testnet.filter(receipt => receipt.delivery === 'delivered').length,
        settledButAborted: testnet.filter(receipt => receipt.delivery === 'aborted').length,
        usdcUnits: testnetUnits.toString(),
        usdc: usdc(testnetUnits),
        wallets: {
          knownOperator: testnetOperatorPayers.size,
          external: testnetExternalPayers.size,
          returningExternal: [...testnetExternalPayers.values()].filter(payerDays => payerDays.size >= 2).length,
        },
      },
    },
    notes: [
      'The window covers supplied log records only; size-based retention, exports and missing records can make it incomplete.',
      'Quotes and payment-signature submissions are separate requests and are not paired into a conversion rate.',
      'A signed submission means the PAYMENT-SIGNATURE header was present; it does not by itself prove a valid signature.',
      'Confirmed settlements require internally consistent v2 records and are deduplicated by network, asset and transaction hash.',
      'When the same receipt appears more than once, returning-wallet dates use its earliest supplied log observation; this is not the onchain transaction timestamp.',
      'Commercial settlement, USDC and wallet totals include Base mainnet only; Base Sepolia receipts are reported separately as excluded testnet activity.',
      'Conflicting records sharing one request ID are excluded from every metric; byte-equivalent parsed records are treated as export duplicates.',
      'Successfully delivered means the server finished a 2xx response; logs cannot prove that a browser rendered or read it.',
      'External excludes only configured known operator wallets; it does not establish organic demand.',
      'Wallet counts are public payment addresses, not counts of people or customers.',
      'USDC totals use integer atomic units from server-selected requirements recorded only after confirmed settlement.',
      'This is application-log evidence and does not independently recheck transactions onchain.',
    ],
  } };
}
