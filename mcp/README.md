# agenttoll-mcp

MCP server for [AgentToll](https://agenttoll-pi.vercel.app) — pay-per-call data
APIs for AI agents, paid in USDC on Base via the x402 protocol. Add it to any
MCP-compatible agent (Claude Desktop, Claude Code, ...) and every endpoint
becomes a native tool; each call is paid automatically from the configured wallet.

## Setup

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

The wallet behind `AGENT_PRIVATE_KEY` needs USDC on Base Sepolia (testnet) —
get some free at [faucet.circle.com](https://faucet.circle.com).

## Tools

`get_price`, `get_base_gas`, `get_trending`, `get_base_token_price`,
`get_base_address_info`, `get_fear_greed`, `get_base_trending_pools`,
`get_market_brief`, `get_new_token_radar`, `get_try_premium`

Prices per call: $0.001–$0.005. Catalog: `GET https://agenttoll-pi.vercel.app/api/catalog`.

MIT — [source](https://github.com/tevfikefeaydin/agenttoll).
