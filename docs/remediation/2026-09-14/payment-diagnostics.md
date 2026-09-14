# PAYMENT-DIAGNOSTICS implementation and schema

Owner: payment implementer. Root and final independent reviewer must review this implementation. This evidence uses local HTTP requests, the actual installed x402 2.21.0 middleware, and offline fake facilitator/RPC responses. No real payment, signature verification, chain settlement, publication or production edit was performed.

## Root causes and changes

The existing logger observed only HTTP finish, status and payment-header presence. Consequently malformed decoding, requirement mismatch, verifier decline and settlement decline shared the same rejected label, and disconnects had no terminal record. Installed SDK decoding also printed JSON parse exceptions. Its v2 extractor ignores X-PAYMENT entirely.

The service now preflights the SDK's actual decoder without printing exceptions, rejects unsupported submissions with an explicit x402 v2 migration response, observes existing SDK matching/extension decisions and facilitator call boundaries, and records the handler boundary. It emits one finish or unfinished-close record. It never retries ambiguous settlement. Unsigned quotes, pricing, recipient, chain and successful v2 payment remain unchanged.

An additional actual SDK privacy defect was reproduced: the successful HTTP facilitator client logs the optional EXTENSION-RESPONSES header. Its field-name allowlist permits arbitrary nested reason/code values and extension names. The SDK provides no logger or fetch injection. A narrowly scoped console adapter suppresses only the exact `[x402] extension responses: ` diagnostic when the current AsyncLocalStorage request contains payment telemetry, including late completion after cancellation. Ordinary logs, other SDK diagnostics, warnings/errors and logs outside request context are preserved. Reassess this version-specific adapter when upgrading x402.

## Request schema version 2

Existing fields remain: `t`, `requestId`, `method`, canonical `path`/`route`, `status`, `ms`, `paymentStage`, `paymentSubmitted`, allowlisted `errorCode`, `upstreamCalls`, `cacheHits`, `cacheMisses`, `coalescedLoads`.

| Field | Meaning |
|---|---|
| `schemaVersion` | `2`; the offline report also accepts old version 1 and historical unclassified rows. |
| `terminal` | `finish` or `abort`, at most one record per request. Normal finish followed by close is not duplicated. |
| `abortReason` | `null`, `client_disconnected`, or `request_timeout`. Only non-null for an unfinished close. |
| `status` | Actual response status on finish; local marker `499` for abort, which is not a response sent to the caller. |
| `paymentHeader` | `none`, `payment-signature`, `x-payment`, or `both`; no header contents. PAYMENT-SIGNATURE takes precedence when both are present. |
| `protocolVersion` | `none`, `v1`, `v2`, or `unknown`. Version reflects decoded PAYMENT-SIGNATURE before verification and is not an authenticated claim. X-PAYMENT alone stays unknown because the header does not prove a payload generation. |
| `paymentPhase` | Last reached boundary: `none`, `initialize`, `parse`, `match`, `verify`, `handler`, `settle`. Extension echo failures are in match. Successful settled responses remain in settle. |
| `paymentReason` | Null on success or a fixed allowlisted reason. Generic fallback declines are `verification_declined`/`settlement_declined`; never arbitrary exception/facilitator text. |
| `facilitatorVerifyCalls`, `facilitatorSettleCalls` | Number of started facilitator method invocations. SDK verify/settle currently make one HTTP attempt each; these are invocation counters, not assertions about redirects or actual network transmission. Shared supported initialization and its internal retries are excluded. |
| `facilitatorVerifyMs`, `facilitatorSettleMs` | Nonnegative total elapsed waiting milliseconds per method, including the unfinished invocation up to the terminal abort. Late results do not alter already emitted records. |
| `client` | Null or `{name, version, source}`. Exact `product/numeric.version` from X-AgentToll-Client, otherwise User-Agent. Known products: agenttoll-mcp, agenttoll-web, curl, python-requests, node, undici. Source is x-agenttoll-client or user-agent. Explicit but malformed metadata produces null. These are self-reported labels, never authenticated identity. |
| `verifiedPayer` | Null or a lowercase 20-byte EVM address from a successful SDK-validated verifier response. Never copied from authorization, rejected verification or a client header. It is a public onchain identifier, not proof of a distinct human/customer. |
| `settlementTransaction` | Null or lowercase 32-byte EVM transaction hash from a successful SDK-validated facilitator settlement result. Failed/unknown settlement receipts and invalid identifier formats are omitted. This records the facilitator's trusted result, not an independent chain recheck. |

`paymentStage` retains none/quote/submitted/rejected/unknown/settled. A valid successful facilitator settlement establishes settled even if delivery subsequently aborts; otherwise abort during settlement is unknown. Verification success followed by handler failure is submitted, with handler/handler_failed. `terminal` distinguishes delivery from settlement. Status 499 does not inflate 5xx counts.

Allowlisted reasons are defined in `src/payment-telemetry.ts`: payment_required, malformed_payment, payment_invalid, unsupported_version, requirements_mismatch, extension_mismatch, verification_declined, settlement_declined, facilitator_unavailable, request_timeout, client_disconnected, handler_failed, invalid_exact_evm_payload_signature, insufficient_funds, invalid_exact_evm_payload_authorization_valid_after, invalid_exact_evm_payload_authorization_valid_before, invalid_exact_evm_payload_authorization_value, invalid_exact_evm_payload_authorization_nonce, invalid_exact_evm_payload_recipient_mismatch, invalid_network, invalid_scheme. An unknown facilitator reason falls back to a generic decline rather than becoming a new log label.

The report adds `diagnostics.recorded`, `aborted`, bounded phase/reason/header/protocol counts and facilitator counter/time totals. It validates new diagnostic enums and nonnegative integer counters. It does not include payer, transaction or client values, infer conversions, or recover missing historical records.

## Regression evidence

Before implementation, the new middleware regression suite failed on schema version, missing phases, missing migration code and missing abort records. The actual malicious EXTENSION-RESPONSES fixture separately failed before the narrow SDK adapter and passed afterward.

Final command outputs are in `payment-tests.log` (40/40 pass, 4.756 seconds), `payment-typecheck-api.log` (exit 0) and `payment-typecheck-tests.log` (exit 0), freshly run on 2026-09-14. The focused tests cover successful v2 quote/payment, handler failure without settlement, decode and extension/requirement mismatch, unsupported headers/versions, verifier and settlement declines, malicious error/identity/client fields, invalid identifier formats, verify/settle deadlines, initialization/verify/handler/settle disconnects, late-result and finish/close duplicate protection, report compatibility/validation, and preservation of unrelated console output.

The fixture explicitly forbids unexpected external fetches. Fabricated signatures are accepted only by the fake facilitator; this is middleware behavior evidence, not cryptographic/production payment evidence.

Changed source/test files: `src/app.ts`, `src/telemetry.ts`, `src/request-context.ts`, `src/operations-report.ts`, new `src/payment-telemetry.ts`, `tests/operations-report.test.ts`, new `tests/payment-diagnostics.test.ts`.
