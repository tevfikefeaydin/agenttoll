# agenttoll-mcp

Version 0.13.0 exposes 21 paid AgentToll tools and two free payment-inspection tools. The hosted API uses real USDC on Base mainnet. Base data always comes from mainnet, even when a self-hosted instance accepts Base Sepolia payments.

## Start without a wallet

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

Without AGENT_PRIVATE_KEY, the server runs in quote-only mode. Call get_payment_budget to inspect the policy, or get_payment_quote with a concrete registered path such as /api/price/eth. Quote inspection does not accept an arbitrary URL and never signs or reserves budget. Paid tools return a missing-wallet error if payment is required.

To enable hosted payments, add a dedicated funded wallet and a finite budget:

```json
"env": {
  "AGENT_PRIVATE_KEY": "0x...",
  "AGENTTOLL_NETWORK": "base",
  "AGENTTOLL_BUDGET_USDC": "1"
}
```

For a self-hosted testnet service, configure AGENTTOLL_URL, AGENTTOLL_NETWORK=base-sepolia and AGENTTOLL_RECIPIENT to the receiver you trust. Changing only the network cannot make the hosted mainnet API accept testnet USDC.

## Configuration and payment limits

| Setting | Behavior |
| --- | --- |
| AGENT_PRIVATE_KEY | Optional paying-wallet secret. Omit for quote-only use. |
| AGENTTOLL_URL | API origin; defaults to https://agenttoll.app. |
| AGENTTOLL_NETWORK | base (default) or base-sepolia; must match the service's payment network. |
| AGENTTOLL_RECIPIENT | Required trusted receiver for a custom origin. Hosted default: 0xe55359021a6a22d8385b827405991c56075f56f8. |
| AGENTTOLL_BUDGET_USDC | Session limit, default 1 USDC, maximum six decimal places; zero disables payments. |
| AGENTTOLL_MAX_PER_CALL_USDC | Optional lower ceiling. A server quote can never exceed its registered endpoint price. |
| AGENTTOLL_TIMEOUT_MS | Total quote/sign/retry/body deadline, default 30000; integer 1–300000. |

The client verifies the registered route, origin, exact USDC amount, network, asset and recipient before signing. Redirects and unrecognized payment methods are rejected. Concurrent calls reserve budget atomically. Cancellation from the MCP client propagates to HTTP and prevents signing a quote that arrives later.

The budget is in memory per server instance. Unsigned failures release their reservation; signed failures or a still-pending signature at timeout/cancellation remain reserved because the authorization may still be redeemable. get_payment_budget reports totalUsdc, spentUsdc, reservedUsdc and remainingUsdc. Restarting creates a new budget; it does not reconcile or revoke old authorizations.

x402 v2 uses PAYMENT-REQUIRED for the quote, PAYMENT-SIGNATURE for the retry and PAYMENT-RESPONSE for the receipt. Handler failures before settlement are not billed. A signed timeout or lost settlement response may have an unknown outcome; inspect the wallet/receipt before retrying.

## Tools

| Tool | USDC per call |
| --- | --- |
| get_payment_budget | free |
| get_payment_quote | free |
| get_price | $0.001 |
| get_base_gas | $0.001 |
| get_trending | $0.002 |
| get_base_token_price | $0.001 |
| get_base_address_info | $0.001 |
| get_fear_greed | $0.001 |
| get_base_trending_pools | $0.002 |
| get_market_brief | $0.005 |
| get_new_token_radar | $0.003 |
| get_try_premium | $0.002 |
| get_try_spread | $0.002 |
| get_base_portfolio | $0.003 |
| check_token_safety | $0.003 |
| scout_new_tokens | $0.008 |
| get_fresh_pools | $0.004 |
| get_radar_history | $0.002 |
| get_radar_scorecard | $0.005 |
| resolve_basename | $0.001 |
| watch_base_address | $0.002 |
| watch_new_tokens | $0.003 |
| watch_price_alert | $0.001 |

Optional parameters do not change registered prices. Tool schemas describe accepted inputs; the [catalog](https://agenttoll.app/api/catalog) lists routes and parameters.

watch_base_address returns an opaque cursor. Pass it unchanged as since and drain pages while hasMore is true before resuming scheduled polling. Each call reads one provider page, with a 120-second overlap and at most 100 remembered transaction hashes. Deduplicate by hash yourself and inspect partial, coverage.complete and coverage.replayPossible. Indexer gaps and older reorganizations are outside that coverage. An initial ISO timestamp is also accepted.

watch_new_tokens uses an ISO cursor over the current ranked radar listing. It is always partial: late-indexed or omitted pools can be missed. watch_price_alert reports threshold status and does not use a cursor.

get_radar_scorecard uses the latest N published snapshot days, not a calendar lookback or fixed holding period. It reports missing snapshots, unassessed tokens and unavailable prices. Null outcomes are not losses; liquidityGone=true means observed liquidity below $100 in the selected provider pair. get_radar_history pins published content to a git SHA. A payment transaction does not authenticate snapshot contents or prove capture time.

Data responses include freshness/network/request metadata; structured API errors include code, retryable, retryAfter and requestId. /api/health is liveness; the free /api/ready checks the facilitator and Base RPC with a bounded probe and a 15-second cache.

## Build and release

The repository build synchronizes the endpoint manifest, payment policy and package version before compiling. The published dist includes version.js, so the handshake does not depend on missing source-tree files.

After changing mcp/package.json, run npm run generate from the repository root to synchronize runtime version data and mcp/server.json. Run the repository checks before an authorized release. The release workflow installs both dependency trees, checks generated artifacts, tests and types, builds MCP, and smoke-tests the npm tarball. Its mcp-v<version> tag must match the package version. Publishing the npm package or registry metadata is a separate remote action; local build success does not publish either.

MIT — [source](https://github.com/tevfikefeaydin/agenttoll).
