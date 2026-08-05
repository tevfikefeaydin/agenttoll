# agenttoll-mcp

MCP server for [AgentToll](https://agenttoll.app) — pay-per-call data
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

The wallet behind `AGENT_PRIVATE_KEY` needs USDC on Base mainnet — a dollar
covers hundreds of calls. To try it against testnet instead, set
`AGENTTOLL_NETWORK=base-sepolia` and fund the wallet from
[faucet.circle.com](https://faucet.circle.com).

## Tools

`get_price`, `get_base_gas`, `get_trending`, `get_base_token_price`,
`get_base_address_info`, `get_fear_greed`, `get_base_trending_pools`,
`get_market_brief`, `get_new_token_radar`, `get_try_premium`,
`resolve_basename`, `watch_base_address`, `watch_new_tokens`, `watch_price_alert`

Several take optional arguments that do not change the price: `get_base_gas`
takes a `gasLimit` and returns what a transaction that size costs,
`get_fear_greed` takes `days` for history, `get_market_brief` takes `symbols`
to price what you actually track, and `get_new_token_radar` takes
`minLiquidity` to set your own spam floor.

The `watch_*` tools return a `cursor`; pass it back as `since` on the next call
to get only what changed — ideal for agents that poll on a schedule.

Prices per call: $0.001–$0.005. Catalog: `GET https://agenttoll.app/api/catalog`.

## Publishing

npm releases are automated: bump `version` here, commit, then push a tag
`mcp-v<version>` — the `publish-mcp.yml` workflow builds and publishes.

Listing in the official [MCP Registry](https://registry.modelcontextprotocol.io)
is a one-time manual step (needs a GitHub device-code login). From this folder:

```powershell
# 1. install the publisher CLI (official release)
$arch = if ([System.Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture -eq "Arm64") { "arm64" } else { "amd64" }
Invoke-WebRequest -Uri "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_windows_$arch.tar.gz" -OutFile "mcp-publisher.tar.gz"
tar xf mcp-publisher.tar.gz mcp-publisher.exe
Remove-Item mcp-publisher.tar.gz

# 2. log in (opens a device code — approve at github.com/login/device)
.\mcp-publisher.exe login github

# 3. publish the metadata in server.json
.\mcp-publisher.exe publish
```

`server.json` and the `mcpName` field in `package.json` are already filled in
(`io.github.tevfikefeaydin/agenttoll`) and must stay in sync with the published
npm version. Verify afterwards:

```bash
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=agenttoll"
```

MIT — [source](https://github.com/tevfikefeaydin/agenttoll).
