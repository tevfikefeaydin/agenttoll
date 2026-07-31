# AgentToll

**Live:** [agenttoll-pi.vercel.app](https://agenttoll-pi.vercel.app) — try `GET /api/price/eth` and get a real x402 quote.

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
| `GET /api/health` | Service status | free |

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

## Going to mainnet

Switch `NETWORK=base` in `.env` and use the Coinbase CDP facilitator (the public
x402.org facilitator is testnet-only):

```ts
import { facilitator } from "@coinbase/x402"; // needs CDP API keys
app.use(paymentMiddleware(payTo, routes, facilitator));
```

## Roadmap

- [ ] More data endpoints (onchain analytics, token metadata, TR-market data)
- [ ] Listing in x402 Bazaar / ecosystem discovery
- [ ] Usage dashboard (calls, revenue, top agents)
- [ ] MCP server wrapper so any AI assistant can use AgentToll as a native tool

## Stack

TypeScript · Express · [`x402-express`](https://www.npmjs.com/package/x402-express) ·
[`x402-fetch`](https://www.npmjs.com/package/x402-fetch) · viem · Base

## License

MIT — open source, building in public.
