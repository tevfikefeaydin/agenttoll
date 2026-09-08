# Task C — bounded payment clients

Owner: `/root/payment_clients`. Reviewer: `/root`, then the independent final reviewer. Completed locally on 2026-09-08; no payment, deployment, publication, commit, or push was performed.

## Implementation

- `src/payment-policy.ts` is the canonical policy; `mcp/payment-policy.ts` is its exact generated copy. It matches concrete request paths against `ENDPOINT_MANIFEST`, enforces the lesser of the registered route price and configured per-call ceiling, and validates exact x402 v2 EIP-3009 USDC quotes for Base or Base Sepolia. Network, USDC contract, recipient, positive integer amount, signing domain, and bounded authorization lifetime are checked before the signer runs. Unknown transfer methods/extensions cannot request additional signatures.
- `payingFetch(privateKey, network, options?)` retains the original first two arguments. Options are `baseUrl`, `recipient`, `totalBudgetUsdc` (default `1`), `maxPerCallUsdc`, and `timeoutMs` (default `30000`, allowed 1–300000). The returned object exposes `fetchWithPayment`, `getPaymentBudget`, `getPaymentQuote`, and the existing address. Custom origins require an explicit trusted recipient; the hosted default is `0xe55359021a6a22d8385b827405991c56075f56f8`.
- Budget arithmetic uses integer micro-USDC. Reservation check/increment occur without an await before signing. Unsigned failures release their reservation. Signed failures and a still-pending signer at timeout retain their reservation; a late signature cannot submit a request. Success moves the reservation to spent. `getPaymentBudget` exposes total/spent/reserved/remaining amounts, network, recipient, asset, API origin, deadline, and signing availability.
- A total deadline covers quotation, signing, HTTP retry, and reading the complete response body. Caller abort signals propagate to HTTP. All redirects are rejected, including different-origin redirects. Only registered GET requests can use automatic payment. Response bodies are buffered within the deadline so callers cannot hang indefinitely while reading them later.
- MCP provides free `get_payment_budget` and `get_payment_quote` tools and starts in quote-only mode without `AGENT_PRIVATE_KEY`. Quote inspection accepts concrete registered endpoint paths, never arbitrary URLs. Paid descriptions derive their price from `ENDPOINT_MANIFEST` through the typed `paidTool` wrapper. Watch descriptions now explain opaque wallet cursors, `hasMore`/`partial`/coverage, and the radar's incomplete listing.
- MCP imports the integration owner's generated `MCP_VERSION` from `version.ts`, which compiles into `dist/version.js` without a runtime source-tree/package-metadata lookup. Main-entry detection resolves npm bin symlinks. `createAgentTollServer(options)` exposes real MCP registration for in-memory transport tests; imports do not start stdio or read a wallet secret.
- `web/demo.ts` accepts `{ quote, recipient?, timeoutMs? }` as its optional third argument. The displayed quote is validated and copied before wallet prompts, then compared against the fresh quote at signing. Base/Base Sepolia selection and explorer links follow the quote. The wallet network is rechecked immediately before signing. All browser RPC uses the injected provider; no external public RPC or CSP exception is needed. Error handling retains the selected address outside try, reports connection/signature cancellation, wrong network, insufficient USDC, facilitator errors, missing wallets, and timeouts without catch-scope crashes or unsupported no-charge assurances. Browser deadline defaults to 120 seconds to include wallet interaction.

## Regression evidence

All network and settlement boundaries are mocked. Tests use fresh ephemeral private keys and real local EIP-712 signatures; none can send a transaction or payment.

| Acceptance | Evidence and observed result |
| --- | --- |
| Reproduce excessive quote and oversubscription | Before implementation, `tests/payment.test.ts` failed with `Missing expected rejection` for a forged 50 USDC quote and `2 !== 1` for two simultaneous calls against a 0.001 USDC budget. Both regressions now pass. |
| Valid quote signs, invalid terms do not | Payment tests inspect a real generated signature's 1000 micro-USDC amount, recipient, and Base Sepolia network. Wrong network, recipient, asset, non-integer amount, excessive lifetime, Permit2 requests, and inflated prices have zero signing-boundary calls. |
| Atomic budget and ambiguous failures | One of two concurrent 0.001 USDC calls succeeds. Signed HTTP/body timeouts retain 0.001 USDC; the next call is budget-blocked. Rejected unsigned signatures free the reservation. Late wallet completion submits no signed HTTP request. |
| Deadline and abort | Both direct fetch signals and retained active Request signals are aborted. Caller pre-abort performs no HTTP call. Full response body hangs time out. An intermittent mock defect was isolated with forced GC: the direct signal was aborted but an unretained cloned Request/listener had been collected. Retaining active requests, as an HTTP transport does, made forced-GC verification pass without weakening cancellation assertions. Diagnostic GC hooks were then removed. |
| Free MCP inspection and expensive MCP quote | Real SDK client/server calls through `InMemoryTransport` inspect quotes and budgets without a key, reject arbitrary quote URLs, and return a useful missing-wallet error for paid calls. The real `get_price` callback rejects 50 USDC with no signed retry. Handshake version matches the generated MCP version. |
| Browser regressions | Before implementation, the browser tests observed `ReferenceError: wallet is not defined`, failure to pay a Base Sepolia quote, and signing after the displayed quote changed. All now pass along with cancellation, insufficient USDC, failed switching, network changes at signing, unrecognized quotes, facilitator failure, missing wallet, and timeout paths. |

Final verification after the last source/test changes:

- `node --import tsx --test tests/payment.test.ts tests/browser-payment.test.ts`: **36 passed, 0 failed**, run concurrently with both typechecks and bundling.
- `npx tsc --noEmit -p mcp/tsconfig.json`: exit 0.
- `npx tsc --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --strict --skipLibCheck web/demo.ts`: exit 0.
- `npx esbuild web/demo.ts --bundle --format=iife --target=es2020 --minify --outfile=<temporary-directory>/agenttoll-payment-demo-20260908.js`: exit 0, 412.0 KB bundle. `public/demo.js` was not edited by this worker.

## Integration notes and limits

The root owner must retain the displayed raw quote in `public/app.js` and call `agentTollPay(endpoint, show, { quote })`, generate the published demo bundle, synchronize shared policy/manifest/version before builds, and update public documentation. These integration contracts were sent during implementation. Registry consistency must recognize `paidTool` registrations; the two free tools remain `server.tool` calls.

MCP environment variables are `AGENTTOLL_NETWORK`, `AGENTTOLL_URL`, `AGENTTOLL_RECIPIENT`, `AGENTTOLL_BUDGET_USDC`, `AGENTTOLL_MAX_PER_CALL_USDC`, and `AGENTTOLL_TIMEOUT_MS`, plus optional `AGENT_PRIVATE_KEY`.

Budgets are in-memory per client instance, not persistent wallet-wide limits. Ambiguous reservations remain until the instance ends; HTTP failure alone cannot invalidate a redeemable signed authorization. This policy intentionally accepts one recognized exact USDC payment option, rejects redirects, and does not support arbitrary URLs, alternate payment schemes, or approval extensions. Final npm tarball smoke testing, complete project checks, and independent product review belong to the integration owner.

## Independent review correction — MCP cancellation

The independent review found that MCP cancellation stopped the SDK caller but the original tool callbacks did not forward `extra.signal` into the bounded payment client. A quote delivered after cancellation could therefore still trigger a signature and payment.

Three real `InMemoryTransport` regressions were added before the fix. The paid quote test reproduced **one signed retry after cancellation** (`1 !== 0`); the free quote and post-signature tests both observed an un-aborted HTTP Request signal (`false !== true`).

`mcp/server.ts` now routes every paid tool through a typed `paidTool` wrapper that binds a callback-local `call` function to that MCP request's `extra.signal`. Its underlying `callEndpoint` requires the signal and passes it to `fetchWithPayment`. The free quote callback also passes `extra.signal` to `getPaymentQuote`. The wrapper registers an explicit `z.object(schema)` through the SDK's `registerTool` API, preserving argument inference without an unchecked cast or shared mutable cancellation context. All 21 paid callbacks use the request-bound function. The shared payment policy and its generated copy required no changes.

Verified outcomes:

- Cancellation while either a paid or free quote is pending aborts the actual HTTP Request; releasing a late quote produces no signature/payment and leaves spent/reserved at zero.
- Cancellation after a signature aborts the HTTP Request and retains **0.001000 USDC reserved**, **0.000000 spent**, **0.000000 remaining**, even if the upstream later returns HTTP 200.
- Final command `node --import tsx --test tests/payment.test.ts tests/browser-payment.test.ts`: **39 passed, 0 failed** (24 payment/MCP tests, 15 browser tests).
- `npx tsc --noEmit -p mcp/tsconfig.json`: exit 0. `git diff --check -- mcp/server.ts tests/payment.test.ts`: exit 0.

The tests continue to use ephemeral keys and mocked external HTTP/settlement only. No real payment or remote write occurred.
