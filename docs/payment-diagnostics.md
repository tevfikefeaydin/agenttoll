# Private payment failure diagnostics

The private usage report now includes `paymentDiagnostics`. Each group gives the
UTC date, canonical route, request HTTP status, payment phase, rejection reason,
count, whether settlement was attempted, a Turkish explanation, and a next step.
`reviewArea` is where to investigate; it does not establish who caused a failure.

## What the detail means

| Evidence | Example operator explanation | Investigation |
| --- | --- | --- |
| Header decoding or shape failure | Ödeme başlığı beklenen biçimde değil. | Client/header construction, including our own clients |
| Mismatching requirement field names | Tutar veya ağ alanı teklifle eşleşmedi. | Compare the current unsigned quote with client construction |
| Known provider signature error | Sağlayıcı ödeme imzasını doğrulayamadı. | Signing implementation and advertised terms |
| Known provider balance/allowance error | Bakiye veya harcama izni yetersiz. | The payer's network, balance and allowance |
| Provider HTTP 401/403 | Sunucunun sağlayıcı erişimi reddedildi. | Our facilitator credentials and permissions |
| Provider HTTP 429/5xx | Sağlayıcı kapasite veya servis hatası bildirdi. | Provider availability, rate limits and connectivity |
| Provider response could not be parsed | Sağlayıcı yanıt biçimi başarısız oldu. | Provider/SDK compatibility |
| Unknown or missing provider reason | Kesin nedeni belirleyecek ayrıntı bulunmuyor. | Provider documentation and the fixed reason-code list |

The original `paymentReason`, HTTP response, payment acceptance and settlement
policy remain unchanged. Diagnostic inspection cannot approve a payment or
replay a signature. No payment value is included in mismatching field names.
When more than one requirement is advertised, the diagnostic does not pick an
arbitrary candidate and blame its fields.

`paymentDiagnostics.total` includes submitted legacy `X-PAYMENT` requests.
The existing `failures.total` retains its narrower `PAYMENT-SIGNATURE` scope.
These totals overlap and must not be added together. Unsigned 402 quotes are
excluded. Existing duplicate/conflicting-request exclusion remains in effect.
Groups are capped at 1,000; `omittedRecords` accounts for additional groups.

## Privacy and limits

- Provider reasons must exactly match a checked-in list. Missing and unrecognized
  reasons have separate markers. Arbitrary provider messages, signed headers,
  authorization values and client-supplied field names are never copied.
- A provider HTTP status is stored only when the SDK exposes it. For the pinned
  SDK's unstructured HTTP errors, only the status number in its fixed error prefix
  is extracted. A successful HTTP response containing a rejection does not expose
  its status through the SDK, so that field remains absent.
- The detail is sanitized again at logging, archive and report boundaries.
  Counts and explanations belong in private operator storage. They are not added
  to public API bodies or public usage statistics.
- Older records remain readable and appear in `withoutDetails`. The deployment
  cannot reconstruct details that were never recorded. Unknown evidence stays
  unknown; a valid payment elsewhere does not rule out an integration defect.

## Enable and verify

Deploy the tested application through the normal CI/deployment gate. Also update
the separate private collector runtime following
[the archive upgrade procedure](../deploy/hetzner/USAGE-ARCHIVE.md).
Application deployment alone does not update the collector's field allowlist.
The runtime needs the matching `payment-diagnostic.ts`, `payment-telemetry.ts`,
`usage-archive.ts` and `settlement-report.ts` (and `operations-report.ts` when that
CLI is installed). No dependency change or archive schema migration is required.

Rehearse on a private archive copy, preserve the matching runtime/state backup,
and confirm existing revenue, delivery and conflict totals before replacement.
After collection, check fresh timestamps and `paymentDiagnostics`. Existing
records are expected to lack new details. Use offline middleware fixtures to
verify provider rejection, authentication and timeout paths without making a
live payment or sending a real signature.
