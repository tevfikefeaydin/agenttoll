/**
 * Bazaar discovery declarations — the schemas we put inside the 402 quote.
 *
 * Indexers read our OpenAPI spec when they can, but that is a second HTTP
 * request that can time out mid-crawl, and when it does the endpoint is
 * reported as having no schema at all. Declaring the same thing in the payment
 * challenge removes that dependency: the answer travels with the quote, so an
 * agent that has only ever seen a 402 already knows how to call us.
 *
 * Each entry is the config for `declareDiscoveryExtension`; app.ts attaches it
 * to the matching paid route.
 */

/** JSON Schema fragment for a set of query or path parameters. */
type Params = { properties: Record<string, unknown>; required?: string[] };

export interface Discovery {
  input?: Record<string, unknown>;
  inputSchema?: Params;
  pathParams?: Record<string, unknown>;
  pathParamsSchema?: Params;
  output: unknown;
}

const address: Pick<Discovery, "pathParams" | "pathParamsSchema"> = {
  pathParams: { address: "0x4200000000000000000000000000000000000006" },
  pathParamsSchema: {
    properties: { address: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" } },
    required: ["address"],
  },
};

const since: Params = {
  properties: {
    since: { type: "string", description: "ISO cursor from the previous reply" },
  },
};

const limit = (max: number, note: string) => ({
  type: "integer",
  minimum: 1,
  maximum: max,
  description: note,
});

export const DISCOVERY: Record<string, Discovery> = {
  "GET /api/price/:symbol": {
    pathParams: { symbol: "eth" },
    pathParamsSchema: {
      properties: {
        symbol: { type: "string", description: "Ticker or CoinGecko id" },
      },
      required: ["symbol"],
    },
    output: {
      symbol: "eth",
      id: "ethereum",
      usd: 1867.28,
      change24h: -0.1,
      source: "coingecko",
      at: "2026-08-05T13:31:57.070Z",
    },
  },

  "GET /api/gas": {
    input: { gasLimit: 150000 },
    inputSchema: {
      properties: {
        gasLimit: {
          type: "integer",
          minimum: 21000,
          maximum: 30000000,
          description: "Optional. Also price a transaction of this gas size",
        },
      },
    },
    output: {
      chain: "base",
      gasPriceWei: "6041753",
      gasPriceGwei: 0.006041753,
      latestBlock: 49573693,
      estimate: { gasLimit: 150000, ethCost: 9.06263e-7, usdCost: 0.001692, ethUsd: 1867.28 },
      at: "2026-08-05T13:32:13.596Z",
    },
  },

  "GET /api/trending": {
    input: { limit: 5 },
    inputSchema: { properties: { limit: limit(25, "Optional. Top N only") } },
    output: {
      coins: [{ id: "hyperliquid", symbol: "hype", name: "Hyperliquid", rank: 18, usd: 22.4, change24h: 3.1 }],
      source: "coingecko",
      at: "2026-08-05T13:31:58.678Z",
    },
  },

  "GET /api/base/token/:address": {
    ...address,
    output: { chain: "base", token: "0x4200000000000000000000000000000000000006", usd: 1867.28, source: "geckoterminal", at: "2026-08-05T13:31:58.678Z" },
  },

  "GET /api/base/address/:address": {
    ...address,
    output: { chain: "base", address: "0xe553...56f8", basename: "agenttoll.base.eth", ethBalance: 0.0019, txCount: 42, isContract: false, at: "2026-08-05T13:31:58.678Z" },
  },

  "GET /api/base/portfolio/:address": {
    ...address,
    input: { minValue: 100, limit: 10 },
    inputSchema: {
      properties: {
        minValue: { type: "number", minimum: 0, description: "Optional. USD floor per holding, default 1" },
        limit: limit(50, "Optional. How many holdings to list, default 20"),
      },
    },
    output: {
      chain: "base",
      address: "0x1985...5c87",
      basename: null,
      native: { symbol: "ETH", balance: 194.68, priceUsd: 1868.57, valueUsd: 363774.32 },
      tokens: [{ symbol: "CBBTC", name: "Coinbase Wrapped BTC", address: "0xcbb7...33bf", balance: 5.673857, priceUsd: 64198, valueUsd: 364250.29 }],
      totalUsd: 7143109.27,
      tokenCount: 52,
      shown: 1,
      hiddenBelowFloor: 48,
      unpriced: 0,
      minValueUsd: 10000,
      source: "blockscout",
      at: "2026-08-05T13:31:58.678Z",
    },
  },

  "GET /api/base/safety/:address": {
    ...address,
    output: {
      chain: "base",
      token: "0x940181a94a35a4569e4529a3cdfb74e38fd98631",
      name: "Aerodrome",
      symbol: "AERO",
      verdict: "caution",
      failed: [],
      warnings: ["owner-powers", "liquidity"],
      unchecked: [],
      checks: [
        { id: "honeypot", status: "pass", detail: "A simulated buy and sell both succeeded" },
        { id: "taxes", status: "pass", detail: "Buy tax 0%, sell tax 0%" },
        { id: "owner-powers", status: "warn", detail: "Owner can: owner can mint new supply" },
      ],
      holderCount: 748566,
      listedOnCex: ["Coinbase"],
      sources: ["goplus", "honeypot.is"],
      disclaimer:
        "Automated checks against public data, not investment advice. Passing every check does not make a token safe.",
      at: "2026-08-05T13:31:58.678Z",
    },
  },

  "GET /api/base/name/:nameOrAddress": {
    pathParams: { nameOrAddress: "agenttoll.base.eth" },
    pathParamsSchema: {
      properties: {
        nameOrAddress: { type: "string", description: "A basename (.base.eth optional) or a 0x address" },
      },
      required: ["nameOrAddress"],
    },
    output: { query: "agenttoll.base.eth", name: "agenttoll.base.eth", address: "0xe553...56f8", resolver: "0x426fA03f...", records: {}, at: "2026-08-05T13:31:58.678Z" },
  },

  "GET /api/base/trending": {
    input: { limit: 5 },
    inputSchema: { properties: { limit: limit(20, "Optional. How many pools, default 10") } },
    output: {
      chain: "base",
      pools: [{ name: "AERO / USDC", pool: "0x6cdc...971d", priceUsd: 0.4206, volume24hUsd: 1118348.8, change24hPct: 2.711, liquidityUsd: 25358508.8 }],
      source: "geckoterminal-trending",
      at: "2026-08-05T13:31:58.678Z",
    },
  },

  "GET /api/base/radar": {
    input: { minLiquidity: 50000, limit: 5 },
    inputSchema: {
      properties: {
        minLiquidity: { type: "number", minimum: 0, description: "Optional. Liquidity floor in USD, default 10000" },
        limit: limit(30, "Optional. How many pools, default 15"),
      },
    },
    output: {
      chain: "base",
      pools: [{ name: "BASED / ETH 1%", pool: "0x2acb...cac0", createdAt: "2026-08-05T13:01:33Z", priceUsd: 0.0000156, volume24hUsd: 19071.46, liquidityUsd: 14246.1 }],
      minLiquidityUsd: 10000,
      count: 1,
      source: "geckoterminal-new-pools",
      at: "2026-08-05T13:31:58.678Z",
    },
  },

  "GET /api/feargreed": {
    input: { days: 7 },
    inputSchema: {
      properties: {
        days: { type: "integer", minimum: 1, maximum: 30, description: "Optional. Add this many days of daily history" },
      },
    },
    output: {
      value: 27,
      classification: "Fear",
      yesterday: 25,
      days: 7,
      history: [{ date: "2026-08-05T00:00:00.000Z", value: 27, classification: "Fear" }],
      at: "2026-08-05T13:32:14.339Z",
    },
  },

  "GET /api/brief": {
    input: { symbols: "eth,degen,aero" },
    inputSchema: {
      properties: {
        symbols: { type: "string", description: "Optional. Comma-separated tickers, up to 6. Default btc,eth,sol" },
      },
    },
    output: {
      majors: { eth: { symbol: "eth", usd: 1867.28, change24h: -0.1 } },
      baseGas: { chain: "base", gasPriceGwei: 0.006, latestBlock: 49573686 },
      sentiment: { value: 27, classification: "Fear", yesterday: 25 },
      at: "2026-08-05T13:31:59.006Z",
    },
  },

  "GET /api/try/premium": {
    input: { asset: "usdt" },
    inputSchema: {
      properties: {
        asset: { type: "string", enum: ["btc", "eth", "usdt", "usdc"], description: "Optional. Cross-rate asset, default btc" },
      },
    },
    output: {
      asset: "usdt",
      assetUsd: 0.999318,
      assetTry: 47.53,
      impliedUsdTry: 47.5624,
      officialUsdTry: 47.2891,
      premiumPct: 0.578,
      at: "2026-08-05T13:31:58.678Z",
    },
  },

  "GET /api/watch/address/:address": {
    ...address,
    input: { since: "2026-08-05T08:40:01Z" },
    inputSchema: since,
    output: {
      chain: "base",
      address: "0xe553...56f8",
      since: "2026-08-05T08:40:01Z",
      count: 1,
      events: [{ hash: "0x4893...3c91", at: "2026-08-05T12:10:44Z", direction: "in", counterparty: "0x5f87...6f78", ethValue: 0, method: "transferWithAuthorization" }],
      cursor: "2026-08-05T12:10:44Z",
      at: "2026-08-05T13:31:58.678Z",
    },
  },

  "GET /api/watch/radar": {
    input: { since: "2026-08-05T08:40:01Z" },
    inputSchema: since,
    output: {
      chain: "base",
      since: "2026-08-05T08:40:01Z",
      count: 1,
      pools: [{ name: "BASED / ETH 1%", pool: "0x2acb...cac0", createdAt: "2026-08-05T13:01:33Z", priceUsd: 0.0000156, volume24hUsd: 19071.46, liquidityUsd: 14246.1 }],
      cursor: "2026-08-05T13:01:33Z",
      at: "2026-08-05T13:31:58.678Z",
    },
  },

  "GET /api/watch/price/:symbol": {
    pathParams: { symbol: "eth" },
    pathParamsSchema: {
      properties: { symbol: { type: "string", description: "Ticker or CoinGecko id" } },
      required: ["symbol"],
    },
    input: { ref: 1900, pct: 2 },
    inputSchema: {
      properties: {
        ref: { type: "number", description: "Reference price in USD to compare against" },
        pct: { type: "number", description: "Threshold in percent, default 2" },
      },
      required: ["ref"],
    },
    output: {
      symbol: "eth",
      usd: 1867.28,
      ref: 1900,
      changePct: -1.7221,
      thresholdPct: 2,
      triggered: false,
      direction: "down",
      at: "2026-08-05T13:31:58.678Z",
    },
  },
};
