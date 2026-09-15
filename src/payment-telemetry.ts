import { decodePaymentSignatureHeader } from '@x402/core/http';

export const paymentPhases = ['none', 'initialize', 'parse', 'match', 'verify', 'handler', 'settle'] as const;
export const paymentReasons = ['payment_required', 'malformed_payment', 'payment_invalid', 'unsupported_version', 'requirements_mismatch',
  'extension_mismatch', 'verification_declined', 'settlement_declined', 'facilitator_unavailable', 'request_timeout',
  'client_disconnected', 'handler_failed', 'invalid_exact_evm_payload_signature', 'insufficient_funds',
  'invalid_exact_evm_payload_authorization_valid_after', 'invalid_exact_evm_payload_authorization_valid_before',
  'invalid_exact_evm_payload_authorization_value', 'invalid_exact_evm_payload_authorization_nonce',
  'invalid_exact_evm_payload_recipient_mismatch', 'invalid_network', 'invalid_scheme'] as const;
export type PaymentReason = typeof paymentReasons[number];
export interface PaymentTelemetry {
  paymentHeader: 'none' | 'payment-signature' | 'x-payment' | 'both';
  protocolVersion: 'none' | 'v1' | 'v2' | 'unknown';
  paymentPhase: typeof paymentPhases[number];
  paymentReason: PaymentReason | null;
  facilitatorVerifyCalls: number;
  facilitatorSettleCalls: number;
  facilitatorVerifyMs: number;
  facilitatorSettleMs: number;
  verifiedPayer: string | null;
  settlementTransaction: string | null;
  settlementConfirmed: boolean;
  settlementAmount?: string;
  settlementAsset?: string;
  settlementNetwork?: string;
  activeFacilitator?: { phase: 'verify' | 'settle'; started: number };
}
export function paymentTelemetry(signature: string | undefined, legacy: string | undefined): PaymentTelemetry {
  return { paymentHeader: signature ? (legacy ? 'both' : 'payment-signature') : legacy ? 'x-payment' : 'none',
    protocolVersion: signature || legacy ? 'unknown' : 'none', paymentPhase: 'none', paymentReason: null,
    facilitatorVerifyCalls: 0, facilitatorSettleCalls: 0, facilitatorVerifyMs: 0, facilitatorSettleMs: 0,
    verifiedPayer: null, settlementTransaction: null, settlementConfirmed: false };
}
const declines = new Set<string>(paymentReasons.filter(reason => reason.startsWith('invalid_') || reason === 'insufficient_funds'));
export function declineReason(value: unknown, settling: boolean): PaymentReason {
  return typeof value === 'string' && declines.has(value) ? value as PaymentReason : settling ? 'settlement_declined' : 'verification_declined';
}
export const publicPayer = (value: unknown): string | null => typeof value === 'string' && /^0x[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : null;
export const publicTransaction = (value: unknown): string | null => typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value) ? value.toLowerCase() : null;

/** Snapshot the exact scheme's server-selected terms only after settlement succeeds. */
export function settledRequirements(value: unknown, receiptNetwork: unknown, receiptAmount: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const requirement = value as Record<string, unknown>;
  if (requirement.scheme !== 'exact' || typeof requirement.amount !== 'string' || !/^[1-9]\d{0,77}$/.test(requirement.amount) ||
    typeof requirement.asset !== 'string' || !/^0x[0-9a-f]{40}$/i.test(requirement.asset) ||
    typeof requirement.network !== 'string' || !/^eip155:\d{1,10}$/.test(requirement.network) ||
    receiptNetwork !== requirement.network || (receiptAmount !== undefined && receiptAmount !== requirement.amount)) return null;
  return { settlementAmount: requirement.amount, settlementAsset: requirement.asset.toLowerCase(), settlementNetwork: requirement.network };
}

/** Parse with the same decoder as the SDK, but never print decoder exceptions. */
export function inspectPayment(signature: string | undefined, legacy: string | undefined, telemetry: PaymentTelemetry): PaymentReason | null {
  telemetry.paymentPhase = 'parse';
  if (!signature) return legacy ? 'unsupported_version' : null;
  try {
    if (signature.length > 16_384) return 'malformed_payment';
    const payload = decodePaymentSignatureHeader(signature);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return 'malformed_payment';
    const version: unknown = payload.x402Version;
    telemetry.protocolVersion = version === 2 ? 'v2' : version === 1 ? 'v1' : 'unknown';
    if (version !== 2) return 'unsupported_version';
    if (!payload.accepted || typeof payload.accepted !== 'object' || Array.isArray(payload.accepted) ||
      !payload.payload || typeof payload.payload !== 'object' || Array.isArray(payload.payload)) return 'malformed_payment';
    return null;
  } catch { return 'malformed_payment'; }
}

/** Client metadata is self-reported, never identity. Unknown products and free text are omitted. */
export function sanitizedClient(explicit?: string, userAgent?: string) {
  const pattern = /^(agenttoll-mcp|agenttoll-web|agenttoll-inspect|curl|python-requests|node|undici)\/(\d{1,4}\.\d{1,4}(?:\.\d{1,4})?)$/i;
  const source = explicit ? 'x-agenttoll-client' : 'user-agent';
  const value = explicit ?? userAgent;
  if (!value || value.length > 128) return null;
  const match = pattern.exec(value);
  return match ? { name: match[1].toLowerCase(), version: match[2], source } : null;
}

/** Include elapsed time up to disconnect even when the facilitator is still pending. */
export function paymentSnapshot(payment: PaymentTelemetry) {
  const { activeFacilitator, settlementConfirmed: _confirmed, ...snapshot } = payment;
  if (activeFacilitator) {
    const key = activeFacilitator.phase === 'verify' ? 'facilitatorVerifyMs' : 'facilitatorSettleMs';
    snapshot[key] += Math.max(0, Date.now() - activeFacilitator.started);
  }
  return snapshot;
}
