# AgentToll

**Live:** [agenttoll-pi.vercel.app](https://agenttoll-pi.vercel.app) — try `GET /api/price/eth` and get a real x402 quote.
Onchain identity: **agenttoll.base.eth** (Base mainnet).

**Pay-per-call APIs for AI agents.** Every endpoint costs a fraction of a cent, paid in
USDC and settled on [Base](https://base.org) via the [x402 protocol](https://x402.org).
No API keys, no subscriptions, no accounts — an agent sends one HTTP request, pays
inline, and gets the data.

> Base's stated goal is to be the default chain for AI agents. AgentToll is a small,
> open building block for that: a tollbooth any agent can drive through autonomously.

## How it works

1. An agent calls an endpoint → the server replies `402 Payment Required` with a machine-readable price quote.
2. The agent signs a USDC payment authorization (EIP-3009) for the quoted amount — no gas needed on the client.
3. The request retries with the `X-PAYMENT` header. The facilitator verifies and settles on Base; the data comes back in the same round trip.

## Endpoints

| Endpoint | Description | Price |
|---|---|---|
| `GET /api/price/:symbol` | Spot price (USD) + 24h change for any asset | $0.001 |
| `GET /api/gas` | Base network gas price + latest block | $0.001 |
| `GET /api/trending` | Tokens trending across the market right now | $0.002 |
| `GET /api/base/token/:address` | Onchain USD price for any Base token by contract address | $0.001 |
| `GET /api/base/address/:address` | Base address snapshot: ETH balance, tx count, contract or EOA | $0.001 |
| `GET /api/feargreed` | Crypto Fear & Greed index with yesterday comparison | $0.001 |
| `GET /api/base/trending` | Trending DEX pools on Base: price, volume, liquidity | $0.002 |
| `GET /api/brief` | One-call market brief: BTC/ETH/SOL, Base gas, sentiment | $0.005 |
| `GET /api/base/radar` | New token radar: fresh Base pools that already have real liquidity | $0.003 |
| `GET /api/try/premium` | Turkish lira premium: implied vs official USD/TRY via BTC cross-rate | $0.002 |
| `GET /api/stats` | Onchain-derived toll counter: calls collected and USDC revenue | free |
| `GET /api/catalog` | Machine-readable catalog of everything for sale | free |
| `GET /api/health` | Service status | free |

Responses are served from a short-lived cache (15-300s depending on endpoint) to
keep upstream sources happy; every paid call still settles onchain.

## Quickstart (server)

```bash
git clone https://github.com/agenttoll/agenttoll
cd agenttoll
npm install
cp .env.example .env   # set ADDRESS to the wallet that should receive payments
npm run dev
```

The server starts on `http://localhost:4021` in **Base Sepolia testnet** mode using the
free public facilitator (`https://x402.org/facilitator`).

Calling a paid endpoint without payment returns the 402 quote:

```bash
curl -i http://localhost:4021/api/price/eth
# HTTP/1.1 402 Payment Required
# { "x402Version": 1, "accepts": [ { "maxAmountRequired": "1000", "asset": "USDC", ... } ] }
```

## Quickstart (paying agent)

```ts
import { wrapFetchWithPayment } from "x402-fetch";
import { privateKeyToAccount } from "viem/accounts";

const pay = wrapFetchWithPayment(fetch, privateKeyToAccount(AGENT_KEY));
const res = await pay("http://localhost:4021/api/price/eth");
console.log(await res.json()); // { symbol: "eth", usd: ..., change24h: ... }
```

Or run the bundled example (needs a funded Base Sepolia test wallet — get testnet USDC
at [faucet.circle.com](https://faucet.circle.com)):

```bash
npm run example:client
```

## Use it as an MCP server (Claude & friends)

AgentToll ships an MCP wrapper: add it to any MCP-compatible agent and the whole
API becomes native tools — each call paid automatically in USDC via x402.

```json
{
  "mcpServers": {
    "agenttoll": {
      "command": "npx",
      "args": ["-y", "agenttoll-mcp"],
      "env": { "AGENT_PRIVATE_KEY": "0x..." }
    }
  }
}
```

No clone needed — the server is on npm as
[`agenttoll-mcp`](https://www.npmjs.com/package/agenttoll-mcp).

Tools exposed: `get_price`, `get_base_gas`, `get_trending`, `get_base_token_price`,
`get_base_address_info`, `get_fear_greed`, `get_base_trending_pools`, `get_market_brief`,
`get_new_token_radar`, `get_try_premium`.

The wallet behind `AGENT_PRIVATE_KEY` needs USDC on Base — the hosted service
settles on mainnet. (Against a self-hosted testnet instance it needs Base Sepolia
USDC — free at [faucet.circle.com](https://faucet.circle.com).)

## Mainnet vs testnet

The hosted service runs on **Base mainnet** and settles real USDC. A fresh clone
defaults to **Base Sepolia** with the free public facilitator, so you can develop
without real funds. To run your own instance on mainnet, set `NETWORK=base` plus
`CDP_API_KEY_ID` / `CDP_API_KEY_SECRET` (Coinbase Developer Platform keys) — the
server picks the CDP facilitator automatically.

## Roadmap

- [x] Base-native data endpoints (onchain token prices, address analytics)
- [x] MCP server wrapper so any AI assistant can use AgentToll as a native tool
- [ ] Mainnet + listing in x402 Bazaar / ecosystem discovery
- [ ] Usage dashboard (calls, revenue, top agents)
- [ ] More endpoints (token metadata, DEX pools, TR-market data)

## Stack

TypeScript · Express · [`x402-express`](https://www.npmjs.com/package/x402-express) ·
[`x402-fetch`](https://www.npmjs.com/package/x402-fetch) · viem · Base

## License

MIT — open source, building in public.
