# Security Policy

## Reporting a vulnerability

Use this repository's private GitHub Security Advisory reporting flow. If it is unavailable, open an issue titled "security" without exploit details or secrets so maintainers can arrange a private report. We aim to respond within 72 hours.

## Payment and credentials

The hosted service settles real USDC on Base mainnet. A self-hosted server defaults to Base Sepolia only when NETWORK is unset; ADDRESS is required and there is no fallback receiving wallet. Base market and chain data always use mainnet, independently of the payment network.

The API does not require customer accounts or API keys. Installations can contain secrets: the default mainnet facilitator needs CDP_API_KEY_ID and CDP_API_KEY_SECRET, upstream providers may use credentials, and paying clients hold AGENT_PRIVATE_KEY. Keep these in environment/secret storage and out of logs, source control, browser bundles, and reports. The API does not need a paying wallet key to receive USDC; its receiving ADDRESS is public.

Payments use x402 v2: PAYMENT-REQUIRED carries the quote, PAYMENT-SIGNATURE the signed retry, and PAYMENT-RESPONSE the settlement receipt. The application settles after a successful handler response. A handler error before settlement is not billed. A lost response, disconnect, or timeout after a signature/settlement request may have an unknown payment outcome; the response may report paymentOutcome: "unknown" and retryable: false. Check the receipt and wallet before retrying.

The bundled Node/MCP client checks the registered endpoint ceiling, expected origin, USDC contract, recipient and network before signing. Its budget defaults to 1 USDC per client instance; a configured per-call ceiling can only lower the route limit. Budget reservation is atomic across concurrent calls. Signed failures and pending signatures at cancellation/timeout remain reserved. Budgets are in-memory instance limits, not persistent wallet-wide spending controls. Custom API hosts require an explicit trusted AGENTTOLL_RECIPIENT. MCP quote/budget inspection works without a private key, and MCP cancellation propagates to the payment request.

## Request boundaries

- Rate limits are per IP, per running application instance: 60 requests/minute in the free API/discovery bucket and 600 requests/minute in the paid-route bucket. Quote and signed retry requests both count. This is not a shared multi-instance DDoS control.
- Proxy trust is disabled by default locally and scoped to one hop on Vercel. TRUST_PROXY accepts false, 1–5 trusted hops, or explicit IP/CIDR entries. Configure it for the actual proxy topology; a broader trust boundary can let clients influence the rate-limit IP.
- Inputs, receiver/network configuration, URL settings and request deadlines are validated. The default server REQUEST_TIMEOUT_MS is 25000; cache keys and metering normalize relevant route forms. API errors carry stable codes and request IDs without raw upstream internals.
- Upstream loads have timeouts and bounded retries; selected results use caches and concurrent callers share in-flight loads. Some data is uncached or has longer history caches. Missing provider evidence stays unknown/null and coverage is reported.
- CORS supports both current x402 v2 and legacy v1 payment headers. Application headers and deployment configuration provide protections such as nosniff and CSP; review the deployment configuration when self-hosting instead of assuming all platform headers/protections apply.
- The browser demo validates its quote, expected receiver and network before signing. A self-hosted demo obtains its public receiver/network configuration from its same-origin agent card; a quote alone does not establish a trusted recipient. Injected wallet RPC is used, with a total interaction deadline.

## Data and publication limits

Automated safety checks are observations, not a guarantee that a token is safe. Absent provider fields cannot pass a check. Address-to-name results require forward verification. Wallet activity has bounded pagination, overlap and deduplication; radar coverage is explicitly partial.

A published git SHA pins snapshot bytes. A USDC payment transaction does not authenticate those bytes or prove the snapshot's capture time. Scorecards compare selected published samples over variable holding periods and retain unavailable outcomes as null.

## Dependency verification

The root and MCP production dependency audits both reported zero advisories during the local 2026-09-08 verification after dependency fixes. This is a dated result, not a guarantee about future advisories or deployed versions. Recheck both dependency trees after updates:

```bash
npm audit --omit=dev
npm --prefix mcp audit --omit=dev
```

Local tests mock external data, HTTP/RPC and settlement boundaries; successful offline tests are not a production deployment or a real-payment security certification.
