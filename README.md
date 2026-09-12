<p align="center">
  <img src="public/og.png" alt="AgentToll — pay-per-call APIs for AI agents" width="100%">
</p>

<h1 align="center">AgentToll</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/agenttoll-mcp"><img src="https://img.shields.io/npm/v/agenttoll-mcp?label=agenttoll-mcp&color=0052FF" alt="npm"></a>
  <img src="https://img.shields.io/badge/network-Base%20mainnet-0052FF" alt="Base mainnet">
  <img src="https://img.shields.io/badge/payments-x402-0052FF" alt="x402">
  <img src="https://img.shields.io/badge/license-MIT-8A97AF" alt="MIT">
  <a href="https://x402-list.com/services/agenttoll?utm_source=badge&utm_medium=referral&utm_campaign=embed"><img src="https://x402-list.com/badge/agenttoll.svg" alt="Listed on x402-list" height="20"></a>
</p>


[agenttoll.app](https://agenttoll.app) provides 21 paid data endpoints for agents, priced from $0.001 to $0.008 in USDC. The hosted service settles on Base mainnet. Onchain identity: agenttoll.base.eth. [Source](https://github.com/tevfikefeaydin/agenttoll) · [MCP package](https://www.npmjs.com/package/agenttoll-mcp).

Fresh-pool discovery, token safety checks, sampled radar history, wallet activity and market data share one API. Base market and chain data always use mainnet; a self-hosted instance can accept payments on Base Sepolia without changing the data network.

## Payment flow

1. An unsigned request returns HTTP 402 with a base64 JSON quote in PAYMENT-REQUIRED.
2. The client validates the endpoint ceiling, expected origin, network, USDC contract and recipient, then signs an EIP-3009 authorization within its budget.
3. The retry carries PAYMENT-SIGNATURE. The facilitator verifies payment and settles after a successful handler response. PAYMENT-RESPONSE carries the settlement receipt.

API consumers do not need an account or API key. Paying clients need a wallet key; operators may need facilitator/upstream credentials. An initial quote and its signed retry are separate HTTP requests.

Handler failures before settlement are not billed. A lost response or timeout after signing/settlement may have an unknown outcome: inspect the receipt and wallet before retrying. The bounded client keeps ambiguous signed amounts reserved.

## Endpoints

| GET endpoint | Description | USDC per call |
| --- | --- | --- |
| /api/price/:symbol | Spot USD price and 24h change | $0.001 |
| /api/gas?gasLimit= | Base gas, latest block and optional transaction-cost estimate | $0.001 |
| /api/trending?limit= | Market-wide trending assets | $0.002 |
| /api/base/token/:address | Onchain Base token price | $0.001 |
| /api/base/address/:address | Base address snapshot and verified primary Basename | $0.001 |
| /api/base/portfolio/:address?minValue=&limit= | Observed holdings and USD valuation with coverage | $0.003 |
| /api/base/safety/:address | Automated token checks and missing-evidence coverage | $0.003 |
| /api/base/scout?minLiquidity=&pools= | Selected radar pools with safety results | $0.008 |
| /api/base/fresh?minutes=&limit=&fundedOnly= | Recent Uniswap v4 pool events, token attribution and funding activity | $0.004 |
| /api/base/radar/history?date= | Published snapshot pinned to an immutable git SHA | $0.002 |
| /api/base/scorecard?days= | Latest published samples compared with current observations | $0.005 |
| /api/base/name/:nameOrAddress | Forward Basename resolution and verified reverse resolution | $0.001 |
| /api/feargreed?days= | Sentiment index with optional daily history | $0.001 |
| /api/base/trending?limit= | Trending Base DEX pools | $0.002 |
| /api/brief?symbols= | Prices, Base gas and sentiment in one call | $0.005 |
| /api/base/radar?minLiquidity=&limit= | Ranked new-pool listing above a liquidity floor | $0.003 |
| /api/try/premium?asset= | Crypto-implied versus official USD/TRY | $0.002 |
| /api/try/spread?asset= | Turkish exchange quotes versus the global USD price | $0.002 |
| /api/watch/address/:address?since= | Paginated confirmed address transactions | $0.002 |
| /api/watch/radar?since= | Newer observations from the current partial radar listing | $0.003 |
| /api/watch/price/:symbol?ref=&pct= | Price threshold check | $0.001 |
| /api/stats | Network/receiver-scoped onchain toll totals | free |
| /api/catalog | Machine-readable endpoint catalog | free |
| /api/demo | Static sample response shapes | free |
| /api/health | Process liveness | free |
| /api/ready | Facilitator and Base RPC readiness | free |

Optional query parameters do not change registered prices. Invalid inputs return 400. fundedOnly accepts the literal values true or false. The catalog and OpenAPI describe parameter limits. Selected upstream results are cached and concurrent loads are coalesced; TTLs vary, and history caches last longer than live-market caches.

## Interpreting the data

Safety responses preserve unknown checks and provider coverage. A missing owner flag or tax is not a pass. clear requires the necessary evidence; a detected failure can still produce high-risk when other checks are unknown. Passing automated checks does not guarantee safety. Portfolio and radar responses also need their partial/coverage fields to be interpreted correctly.

Address-to-Basename results are forward-resolved back to the original address. Fresh pools cover Uniswap v4; token attribution can be null, ages are estimates from block height, and funded records observed liquidity events rather than a USD liquidity valuation.

### Wallet and radar watches

For /api/watch/address/:address, keep the opaque cursor unchanged and pass it as since. Continue while hasMore is true before scheduled polling resumes. Each call reads one provider page; partial and coverage.complete report whether that scan has drained. An initial ISO timestamp is accepted.

The polling overlap is 120 seconds, with at most 100 remembered transaction hashes. Deduplicate by hash in the consuming agent, especially when coverage.replayPossible is true. These bounds do not cover all delayed indexing, older reorganizations or indexer gaps.

The radar watch uses an ISO cursor over a ranked, liquidity-filtered listing. Its coverage is always partial: an omitted or late-indexed pool can be missed. The price-alert watch reports a threshold result and has no cursor.

### Published history and scorecards

The snapshot workflow writes selected scout observations to [data/scout/](data/scout/) and publishes them in git. History reads pin the index and snapshot bytes to one immutable revision, exposed through provenance.revision and commit/raw links. The payment transaction is a settlement record; it does not authenticate snapshot contents or prove capture time.

For scorecards, days selects the latest N published snapshot days, not a strict calendar lookback. Tokens use their first sighting in that selected window, so holding periods vary. Coverage reports missing snapshots, unassessed pools and unavailable quotes. Price changes and outcomes stay null when unavailable. liquidityGone=true means observed liquidity below $100 in the selected provider pair; it is not proof that all liquidity vanished. Medians use only priced observations. These selected samples are not an exhaustive record of Base launches.

### Responses, failures and readiness

Successful data responses include meta.requestId, servedAt, observedAt, ageSeconds, dataNetwork and paymentNetwork. Unavailable observation timestamps and ages remain null. The HTTP X-Request-Id header identifies the request.

Structured API errors include error, code, retryable, retryAfter and requestId. Typical statuses are 400 for invalid input, 413 for an oversized body, 429 for rate limits, 502 for unavailable upstreams and 504 for deadlines. A settlement attempt with an unknown outcome reports paymentOutcome: "unknown" and retryable: false. Follow Retry-After when provided; do not automatically retry an ambiguous signed payment.

The free /api/health endpoint reports liveness. /api/ready checks facilitator support and the Base RPC with a bounded probe, caches the result for 15 seconds, and returns 503 when not ready. Readiness is not a guarantee that every data provider is available.

## Run your own server

Requires Node.js 22 or newer.

```bash
git clone https://github.com/tevfikefeaydin/agenttoll
cd agenttoll
npm install
cp .env.example .env
# Replace ADDRESS with your public receiving wallet address.
npm run dev
```

The default is http://localhost:4021 with Base Sepolia payments. ADDRESS is mandatory; leaving the placeholder or a zero/malformed address causes startup to fail. Do not use a production wallet key as server ADDRESS: ADDRESS is a public receiver, not a private key.

| Setting | Meaning |
| --- | --- |
| ADDRESS | Required nonzero public receiving address |
| NETWORK | base-sepolia (default) or base; controls settlement only |
| PUBLIC_URL | Public service URL for discovery; defaults locally to http://localhost:PORT and uses the Vercel host on Vercel |
| PORT | Local port, default 4021 |
| REQUEST_TIMEOUT_MS | Total request deadline, default 25000; allowed 100–120000 |
| TRUST_PROXY | false, 1–5 trusted hops, or explicit IP/CIDR entries; locally false by default, one hop on Vercel |
| FACILITATOR_URL | Default https://x402.org/facilitator; the default on mainnet selects CDP |
| CDP_API_KEY_ID / CDP_API_KEY_SECRET | Both required when using the default mainnet CDP facilitator |
| BLOCKSCOUT_API_KEY | Optional upstream quota credential |

URL settings require HTTPS except on localhost. Configure PUBLIC_URL and TRUST_PROXY for the actual deployment. The per-instance rate limits are 60 free API/discovery requests and 600 paid-route requests per minute per IP; unsigned quotes and signed retries both count. They are not a shared multi-instance rate limiter.

Calling a paid endpoint without a signature only inspects its quote:

```bash
curl -i http://localhost:4021/api/price/eth
# HTTP/1.1 402 Payment Required
# PAYMENT-REQUIRED: <base64 x402 v2 quote>
```

The browser demo reads the self-hosted receiver/network from its same-origin agent card, validates the displayed quote and signs only those terms. It supports Base and Base Sepolia and uses the injected wallet's RPC.

## Bounded paying clients

[src/pay.ts](src/pay.ts) exposes payingFetch(privateKey, network, options?). It defaults to a finite 1 USDC budget per client instance and a 30000 ms total deadline. Quotes cannot exceed their registered endpoint price. An optional maxPerCallUsdc may lower that ceiling. Budget checks/reservations are atomic across concurrent calls.

```ts
import { payingFetch } from "./src/pay.js";

const key = process.env.AGENT_PRIVATE_KEY;
if (!key) throw new Error("AGENT_PRIVATE_KEY is required");
const client = payingFetch(key, "base", {
  baseUrl: "https://agenttoll.app",
  totalBudgetUsdc: "1",
  maxPerCallUsdc: "0.008",
  timeoutMs: 30_000,
});
console.log(await client.getPaymentQuote("/api/price/eth")); // no payment
const response = await client.fetchWithPayment("/api/price/eth");
console.log(await response.json());
console.log(client.getPaymentBudget());
```

Executing the signed request above spends real mainnet USDC if successful. getPaymentBudget reports total/spent/reserved/remaining amounts. Signed failures or a pending signature at timeout/cancellation retain their reservation. Budgets reset with the client instance and do not revoke earlier authorizations. Caller AbortSignals are honored; redirects and unregistered routes are rejected.

For a custom origin, pass baseUrl and an explicit trusted recipient. The two TypeScript examples default to localhost, where they may reuse the server's public ADDRESS. They do not reuse ADDRESS for remote hosts. AGENTTOLL_NETWORK takes priority; localhost otherwise follows NETWORK (default base-sepolia), while remote examples/scripts default to base.

The examples and paid scripts accept AGENTTOLL_BUDGET_USDC, AGENTTOLL_MAX_PER_CALL_USDC and AGENTTOLL_TIMEOUT_MS. To use a remote testnet service, explicitly set AGENTTOLL_NETWORK=base-sepolia and AGENTTOLL_RECIPIENT. Testnet USDC cannot pay the hosted mainnet API.

```bash
npm run example:client
npm run example:langchain
```

These commands make paid requests using AGENT_PRIVATE_KEY. The LangChain tool forwards framework cancellation signals. The snapshot/demo/findings scripts also use the bounded helper; build first because they import dist. scripts/demo.mjs --dry performs validated quote inspection only.

## MCP

The MCP package is version 0.13.0, with 21 paid tools and two free tools. Start without AGENT_PRIVATE_KEY for quote-only mode:

```json
{
  "mcpServers": {
    "agenttoll": {
      "command": "npx",
      "args": ["-y", "agenttoll-mcp"]
    }
  }
}
```

The free tools are get_payment_budget and get_payment_quote. Paid tools are get_price, get_base_gas, get_trending, get_base_token_price, get_base_address_info, get_fear_greed, get_base_trending_pools, get_market_brief, get_new_token_radar, get_try_premium, get_try_spread, get_base_portfolio, check_token_safety, scout_new_tokens, get_fresh_pools, get_radar_history, get_radar_scorecard, resolve_basename, watch_base_address, watch_new_tokens and watch_price_alert.

Add AGENT_PRIVATE_KEY to enable payments, and AGENTTOLL_BUDGET_USDC to choose a session limit. MCP defaults to the hosted mainnet origin and requires AGENTTOLL_RECIPIENT for a custom origin. get_payment_quote accepts registered endpoint paths, never arbitrary URLs. Tool cancellation propagates to payment HTTP requests. See [mcp/README.md](mcp/README.md) for all prices and configuration.

## Discovery and development

- [Catalog](https://agenttoll.app/api/catalog)
- [OpenAPI](https://agenttoll.app/openapi.json)
- [x402 discovery](https://agenttoll.app/.well-known/x402)
- [Agent card](https://agenttoll.app/.well-known/agent-card.json)
- [llms.txt](https://agenttoll.app/llms.txt)

```bash
npm test                 # deterministic offline regressions
npm run typecheck        # API, browser and MCP
npm run check:generated  # manifests, descriptions, examples and version consistency
npm run build            # synchronize shared files, compile and build browser bundle
npm run build:web        # browser bundle only
npm run brand:png        # brand exports
```

Development checks use mocked external data/payment boundaries. They do not send real payments or deploy changes. Root and MCP are separate dependency trees; audit both. See [SECURITY.md](SECURITY.md) for credentials, trust boundaries and known limits.

Use `npm run ops:check` for a bounded, unsigned health/catalog/quote check, and `npm run ops:report -- --input requests.ndjson` for an offline usage/error/latency summary. Keep-warm and scout snapshot scripts support explicit `--dry-run` and `--quote-only` modes after a build. The stats snapshot job resumes verified finalized checkpoints and rebuilds a legacy baseline once. See [OPERATIONS.md](OPERATIONS.md) for limits, metric definitions, scheduled jobs and the approval-dependent release/rollback procedure.

After changing the MCP package version, run npm run generate from the repository root. An authorized release tag must match mcp-v<package version>; the workflow checks both dependency trees, generated artifacts, tests and types, then builds and smoke-tests the npm tarball before publishing.

MIT. This repository is the independent AgentToll project at agenttoll.app, not similarly named services operated elsewhere.
