import { ENDPOINT_MANIFEST } from './endpoint-manifest.js';

/** Private operator diagnostics. Only fixed codes/field names, never payment values or provider text. */
export const providerReasonCodes = [
  'invalid_exact_evm_payload_signature', 'insufficient_funds', 'invalid_network', 'invalid_scheme',
  'invalid_exact_evm_payload_authorization_valid_after', 'invalid_exact_evm_payload_authorization_valid_before',
  'invalid_exact_evm_payload_authorization_value', 'invalid_exact_evm_payload_authorization_nonce',
  'invalid_exact_evm_payload_recipient_mismatch', 'asset_not_deployed_contract', 'invalid_exact_evm_scheme',
  'invalid_exact_evm_network_mismatch', 'invalid_exact_evm_missing_eip712_domain', 'invalid_exact_evm_recipient_mismatch',
  'invalid_exact_evm_signature', 'invalid_exact_evm_authorization_value', 'invalid_exact_evm_payload_authorization_value_mismatch',
  'invalid_exact_evm_transaction_failed', 'invalid_exact_evm_transfer_event_mismatch', 'invalid_exact_evm_token_name_mismatch',
  'invalid_exact_evm_token_version_mismatch', 'invalid_exact_evm_eip3009_not_supported', 'invalid_exact_evm_nonce_already_used',
  'invalid_exact_evm_insufficient_balance', 'invalid_exact_evm_transaction_simulation_failed',
  'invalid_permit2_spender', 'invalid_permit2_recipient_mismatch', 'permit2_deadline_expired', 'permit2_not_yet_valid',
  'permit2_amount_mismatch', 'permit2_token_mismatch', 'invalid_permit2_signature', 'permit2_allowance_required',
  'permit2_simulation_failed', 'permit2_insufficient_balance', 'permit2_proxy_not_deployed', 'permit2_invalid_amount',
  'permit2_invalid_destination', 'permit2_invalid_owner', 'permit2_payment_too_early', 'permit2_invalid_nonce',
  'permit2_2612_amount_mismatch', 'invalid_erc20_approval_extension_format', 'erc20_approval_from_mismatch',
  'erc20_approval_asset_mismatch', 'erc20_approval_spender_not_permit2', 'erc20_approval_tx_wrong_target',
  'erc20_approval_tx_wrong_selector', 'erc20_approval_tx_wrong_spender', 'erc20_approval_tx_invalid_calldata',
  'erc20_approval_tx_signer_mismatch', 'erc20_approval_tx_invalid_signature', 'erc20_approval_tx_parse_failed',
  'erc20_approval_tx_failed', 'invalid_eip2612_extension_format', 'eip2612_from_mismatch', 'eip2612_asset_mismatch',
  'eip2612_spender_not_permit2', 'eip2612_deadline_expired', 'unsupported_payload_type', 'invalid_transaction_state',
  'eip6492_factory_not_allowed', 'smart_wallet_deployment_failed', 'extension_echo_mismatch',
] as const;
const providerCodes = new Set<string>(providerReasonCodes);
const detailCodes = ['legacy_header', 'header_too_large', 'header_decode_failed', 'payload_not_object',
  'unsupported_version', 'accepted_not_object', 'authorization_not_object', 'requirements_mismatch',
  'requirements_unavailable', 'multiple_requirements', 'sdk_match_rejected', 'extension_mismatch',
  'facilitator_declined', 'facilitator_timeout', 'facilitator_http_error', 'facilitator_invalid_response', 'facilitator_transport_error',
  'request_deadline', 'client_disconnected', 'handler_failed', 'payment_configuration', 'diagnostic_unavailable'] as const;
const fields = ['scheme', 'network', 'asset', 'amount', 'payTo', 'maxTimeoutSeconds', 'extra', 'other'] as const;
type Field = typeof fields[number];
export type PaymentDiagnostic = {
  version: 1;
  code: typeof detailCodes[number];
  providerCode?: typeof providerReasonCodes[number] | 'missing' | 'unrecognized';
  providerHttpStatus?: number;
  mismatchFields?: Field[];
};
type Row = Record<string, unknown>;
const object = (v: unknown): v is Row => !!v && typeof v === 'object' && !Array.isArray(v);
const httpStatus = (v: unknown): v is number => Number.isInteger(v) && Number(v) >= 100 && Number(v) <= 599;

/** Rebuild at every persistence/report boundary; extra keys and arbitrary strings cannot pass through. */
export function sanitizePaymentDiagnostic(value: unknown): PaymentDiagnostic | null {
  if (!object(value) || value.version !== 1 || !detailCodes.includes(value.code as PaymentDiagnostic['code'])) return null;
  const result: PaymentDiagnostic = { version: 1, code: value.code as PaymentDiagnostic['code'] };
  if (Object.hasOwn(value, 'providerCode')) result.providerCode = typeof value.providerCode === 'string' &&
    (providerCodes.has(value.providerCode) || ['missing', 'unrecognized'].includes(value.providerCode))
    ? value.providerCode as PaymentDiagnostic['providerCode'] : 'unrecognized';
  if (httpStatus(value.providerHttpStatus)) result.providerHttpStatus = value.providerHttpStatus;
  const mismatches = value.mismatchFields;
  if (Array.isArray(mismatches)) result.mismatchFields = fields.filter(f => mismatches.includes(f));
  return result;
}

export function providerDiagnostic(reason: unknown, status?: unknown): PaymentDiagnostic {
  return { version: 1, code: 'facilitator_declined',
    providerCode: reason === undefined || reason === null || reason === '' ? 'missing' :
      typeof reason === 'string' && providerCodes.has(reason) ? reason as typeof providerReasonCodes[number] : 'unrecognized',
    ...(httpStatus(status) ? { providerHttpStatus: status } : {}) };
}

export function facilitatorExceptionDiagnostic(error: unknown): PaymentDiagnostic {
  const name = error instanceof Error ? error.name : '';
  if (name === 'RouteConfigurationError') return { version: 1, code: 'payment_configuration' };
  if (name === 'TimeoutError' || name === 'FacilitatorTimeoutError') return { version: 1, code: 'facilitator_timeout' };
  if (name === 'FacilitatorResponseError') return { version: 1, code: 'facilitator_invalid_response' };
  // @x402/core 2.21 exposes only a fixed message prefix for unstructured HTTP errors.
  // Extract the numeric status only; never copy the provider's response excerpt.
  const match = error instanceof Error ? /^Facilitator (?:verify|settle) failed \(([1-5]\d{2})\):/.exec(error.message) : null;
  return match ? { version: 1, code: 'facilitator_http_error', providerHttpStatus: Number(match[1]) } :
    { version: 1, code: 'facilitator_transport_error' };
}

/** Mirrors SDK core equality/extra-subset semantics only for diagnosis; never authorizes a payment. */
export function requirementsDiagnostic(available: unknown, payload: unknown): PaymentDiagnostic {
  try {
    if (!Array.isArray(available) || !available.length) return { version: 1, code: 'requirements_unavailable' };
    // Do not blame fields from an arbitrarily selected alternative quote.
    if (available.length !== 1) return { version: 1, code: 'multiple_requirements' };
    const required = available[0], accepted = object(payload) ? payload.accepted : null;
    if (!object(required) || !object(accepted)) return { version: 1, code: 'diagnostic_unavailable' };
    let budget = 2048;
    const equal = (a: unknown, b: unknown, subset = false, depth = 0): boolean => {
      if (--budget < 0 || depth > 16) throw new Error('Diagnostic comparison bound');
      if (a === b) return true;
      if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((v, i) => equal(v, b[i], false, depth + 1));
      if (!object(a) || !object(b)) return false;
      const keys = Object.keys(a);
      return (subset || keys.length === Object.keys(b).length) && keys.every(k =>
        Object.hasOwn(b, k) ? equal(a[k], b[k], subset, depth + 1) : subset && a[k] === undefined);
    };
    const mismatchFields: Field[] = [];
    const coreFields = fields.filter(f => f !== 'extra' && f !== 'other');
    for (const key of coreFields) {
      if (Object.hasOwn(required, key) !== Object.hasOwn(accepted, key) || !equal(required[key], accepted[key])) mismatchFields.push(key);
    }
    if (required.extra !== undefined && !equal(required.extra, accepted.extra, true)) mismatchFields.push('extra');
    const extraCore = (v: Row) => Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'extra' && !coreFields.includes(k as typeof coreFields[number])));
    if (!equal(extraCore(required), extraCore(accepted))) mismatchFields.push('other');
    return { version: 1, code: mismatchFields.length ? 'requirements_mismatch' : 'sdk_match_rejected', mismatchFields };
  } catch { return { version: 1, code: 'diagnostic_unavailable' }; }
}

/** Investigation guidance is evidence, not a claim that the caller or provider is at fault. */
export function explainPaymentDiagnostic(reason: unknown, value: unknown) {
  const d = sanitizePaymentDiagnostic(value);
  const guidance = (reviewArea: string, explanationTr: string, actionTr: string) => ({ reviewArea, explanationTr, actionTr });
  const code = d?.code;
  const provider = d?.providerCode ?? (typeof reason === 'string' && providerCodes.has(reason) ? reason : '');
  if (d?.providerHttpStatus === 401 || d?.providerHttpStatus === 403) return guidance('server_configuration',
    'Ödeme sağlayıcısı sunucunun erişimini reddetti.', 'Sunucudaki sağlayıcı yetkilerini ve erişim yapılandırmasını kontrol et; kimlik bilgilerini rapora yazma.');
  if (d?.providerHttpStatus === 429 || (d?.providerHttpStatus ?? 0) >= 500) return guidance('provider_or_network',
    'Ödeme sağlayıcısı kapasite veya servis hatası bildirdi.', 'Sağlayıcı durumunu ve istek sınırlarını incele; ödeme yetkisini otomatik yeniden gönderme.');
  if (code === 'requirements_unavailable' || code === 'sdk_match_rejected' || code === 'payment_configuration') return guidance('server_configuration',
    'Sunucunun ödeme şartları veya SDK eşleştirmesi incelenmeli.', 'Sunucunun yayınladığı teklifi, ağ/varlık ayarlarını ve SDK uyumluluğunu doğrula.');
  if (['invalid_exact_evm_missing_eip712_domain', 'invalid_exact_evm_token_name_mismatch',
    'invalid_exact_evm_token_version_mismatch', 'asset_not_deployed_contract', 'permit2_proxy_not_deployed',
    'invalid_exact_evm_eip3009_not_supported'].includes(provider)) return guidance('server_configuration',
    'Sağlayıcı varlık veya imzalama alanı yapılandırmasında uyumsuzluk bildirdi.',
    'Yayınlanan teklifin ağ, varlık ve imzalama alanı bilgilerini kullanılan ödeme yöntemiyle karşılaştır.');
  if (['insufficient_funds', 'invalid_exact_evm_insufficient_balance', 'permit2_insufficient_balance',
    'permit2_allowance_required'].includes(provider)) return guidance('payer_funds_or_allowance',
    'Sağlayıcı bakiye veya harcama izninin yetersiz olduğunu bildirdi.', 'İstemcinin doğru ağdaki bakiye ve izin durumunu kontrol et; otomatik ödeme yapma.');
  if (provider.includes('signature')) return guidance('client_or_integration',
    'Sağlayıcı ödeme imzasını doğrulayamadı.', 'İstemcinin imzalama yöntemi ile sunucunun yayınladığı teklifin uyumunu incele; imzayı kaydetme veya yeniden gönderme.');
  if (provider.includes('valid_before') || provider.includes('deadline_expired')) return guidance('client_or_integration',
    'Sağlayıcı ödeme yetkisinin son geçerlilik zamanını reddetti.', 'İstemci/sunucu saatlerini ve tekliften imzalamaya kadar geçen süreyi kontrol et.');
  if (provider.includes('valid_after') || provider.includes('not_yet_valid') || provider.includes('too_early')) return guidance('client_or_integration',
    'Ödeme yetkisinin başlangıç zamanı henüz geçerli değil.', 'İstemci/sunucu saatlerini ve yetkinin başlangıç zamanının nasıl üretildiğini kontrol et.');
  if (provider.includes('nonce')) return guidance('payment_authorization',
    'Ödeme yetkisinin tek kullanımlık değeri geçersiz veya daha önce kullanılmış.', 'Tekrar deneme davranışını incele; önce önceki ödemenin sonucunu doğrula.');
  if (provider.includes('amount') || provider.includes('authorization_value')) return guidance('client_or_integration',
    'Sağlayıcı ödeme tutarını geçersiz veya tekliften farklı buldu.', 'İstemcinin birim dönüşümünü ve sunucunun teklif tutarını karşılaştır; tutar değerlerini günlüğe ekleme.');
  if (provider.includes('network') || ['invalid_scheme', 'invalid_exact_evm_scheme'].includes(provider)) return guidance('server_configuration',
    'Ödeme ağı veya ödeme yöntemi beklenen yapılandırmayla eşleşmedi.', 'Sunucunun teklifini, sağlayıcının desteklediği ağı ve istemci seçimini birlikte doğrula.');
  if (provider.includes('simulation') || provider.includes('transaction_failed') || provider.includes('transfer_event') ||
    ['erc20_approval_tx_failed', 'smart_wallet_deployment_failed', 'invalid_transaction_state'].includes(provider)) return guidance('provider_or_network',
    'Sağlayıcı zincir işlemi, simülasyon veya transfer doğrulamasında hata bildirdi.',
    'Sağlayıcı ve zincir durumunu incele; tahsilat başladıysa sonucu kesinleştirmeden yeniden ödeme deneme.');
  if (['legacy_header', 'unsupported_version'].includes(code ?? '') || reason === 'unsupported_version') return guidance('client_or_integration',
    'Desteklenmeyen ödeme protokolü veya eski başlık kullanıldı.', 'İstemciyi x402 v2 ve PAYMENT-SIGNATURE başlığına geçir; yeni bir imzasız teklif ile uyumluluğu kontrol et.');
  if (['header_too_large', 'header_decode_failed', 'payload_not_object', 'accepted_not_object', 'authorization_not_object'].includes(code ?? '') || reason === 'malformed_payment') return guidance('client_or_integration',
    'Ödeme başlığı veya içindeki veri beklenen biçimde değil.', 'İstemcinin başlık üretimini ve kodlama biçimini kontrol et; imza veya başlık içeriğini kaydetme.');
  if (['requirements_mismatch', 'multiple_requirements', 'extension_mismatch'].includes(code ?? '') || reason === 'requirements_mismatch') return guidance('client_or_integration',
    'Gönderilen ödeme şartları veya ek bilgiler sunucunun teklifiyle eşleşmedi.',
    'Belirtilen alanları güncel imzasız teklifle karşılaştır; hem kendi istemcimizi hem sunucunun teklif üretimini incele.');
  if (code === 'handler_failed' || reason === 'handler_failed') return guidance('application_or_upstream',
    'API verisi hazırlanırken hata oluştu.', 'Uygulama ve veri kaynağı sağlığını incele; tahsilat/yanıt durumunu ayrıca kontrol et.');
  if (code === 'client_disconnected' || reason === 'client_disconnected') return guidance('connection',
    'İstek tamamlanmadan bağlantı kapandı.', 'İstemci, proxy ve ağ zaman aşımını incele; yeniden denemeden önce ödeme sonucunu kontrol et.');
  if (['request_deadline', 'facilitator_timeout'].includes(code ?? '') || reason === 'request_timeout') return guidance('provider_or_network',
    'İstek veya ödeme sağlayıcısı zaman sınırını aştı.', 'Gecikmenin oluştuğu aşamayı incele; tahsilat başladıysa sonucu kesinleştirmeden tekrar ödeme yapma.');
  if (['facilitator_http_error', 'facilitator_invalid_response', 'facilitator_transport_error'].includes(code ?? '') || reason === 'facilitator_unavailable') return guidance('provider_or_network',
    'Ödeme sağlayıcısı bağlantısı veya yanıt biçimi başarısız oldu.', 'Sağlayıcı sağlığı, sunucu erişimi ve SDK uyumluluğunu kontrol et.');
  if (provider && !['missing', 'unrecognized'].includes(provider)) return guidance('payment_authorization',
    'Ödeme sağlayıcısının ayrıntılı ret kodu kaydedildi.',
    'Ret koduna göre imza, süre, ağ ve ödeme şartlarını incele; ret kodu tek başına hatanın kime ait olduğunu kanıtlamaz.');
  return guidance('unknown', 'Kesin nedeni belirleyecek ayrıntı bulunmuyor.',
    d?.providerCode === 'unrecognized' ? 'Sağlayıcının resmi hata kodlarını inceleyip sabit izin listesini güncelle; ham mesaj veya imzayı kaydetme.' :
      'Sağlayıcı ve istemci sürümünü incele; eski kayıtlarda bulunmayan ayrıntıyı tahmin etme.');
}

/** Aggregate only already validated, deduplicated paid requests, including legacy rejections. */
export function paymentDiagnosticSummary() {
  let total = 0, withDetails = 0, omittedGroups = 0;
  const paidRoutes = new Set<string>(ENDPOINT_MANIFEST.map(endpoint => endpoint.path));
  const groups = new Map<string, { facts: Row; count: number }>();
  return {
    add(row: Row, route: string) {
      if (!paidRoutes.has(route) || !['GET', 'HEAD'].includes(String(row.method)) ||
        !row.paymentSubmitted || Number(row.status) < 400 || row.paymentStage === 'quote') return;
      total++;
      const detail = sanitizePaymentDiagnostic(row.paymentDiagnostic);
      if (detail) withDetails++;
      const facts = { date: new Date(String(row.t)).toISOString().slice(0, 10), route,
        status: row.status, phase: row.paymentPhase, reason: row.paymentReason, header: row.paymentHeader,
        diagnostic: detail, settlementAttempted: Number(row.facilitatorSettleCalls) > 0 };
      const key = JSON.stringify(facts), current = groups.get(key);
      if (current) current.count++;
      else if (groups.size < 1000) groups.set(key, { facts, count: 1 });
      else omittedGroups++;
    },
    result() {
      return { total, withDetails, withoutDetails: total - withDetails, omittedRecords: omittedGroups,
        scope: 'Deduplicated paid-route failures with a submitted payment header, including legacy X-PAYMENT. Review areas are investigation guidance, not established fault.',
        groups: [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, { facts, count }]) => ({
          ...facts, count, ...explainPaymentDiagnostic(facts.reason, facts.diagnostic),
        })),
      };
    },
  };
}
