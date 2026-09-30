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
    since: { type: "string", description: "Echo the previous reply cursor unchanged; wallet cursors are opaque, radar cursors are ISO timestamps" },
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
      "symbol": "eth",
      "id": "ethereum",
      "usd": 1867.28,
      "change24h": -0.1,
      "source": "coingecko",
      "at": "2026-08-05T13:31:57.070Z",
      "quoteCurrency": "USD",
      "assumptions": []
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

  "GET /api/base/scout": {
    input: { minLiquidity: 25000, pools: 3 },
    inputSchema: {
      properties: {
        minLiquidity: { type: "number", minimum: 0, description: "Optional. Liquidity floor in USD, default 15000" },
        pools: { type: "integer", minimum: 1, maximum: 4, description: "Optional. How many pools to check, default 3" },
      },
    },
    output: {
      chain: "base",
      minLiquidityUsd: 25000,
      pools: [
        {
          name: "SAAS / WETH 1%",
          pool: "0x1c3a...9d2e",
          token: "0x74bb95da6692c34ee9755ac87ea10366653dbc77",
          createdAt: "2026-08-06T09:12:44Z",
          priceUsd: 0.0021,
          volume24hUsd: 88410.2,
          liquidityUsd: 445120.5,
          safety: { verdict: "high-risk", failed: ["liquidity"], warnings: ["creator-stake"], unchecked: [] },
        },
      ],
      summary: { found: 3, checked: 3, unchecked: 0, highRisk: 1, caution: 2, insufficientData: 0, clear: 0 },
      source: "geckoterminal-new-pools",
      disclaimer: "Automated checks against public data, not investment advice.",
      at: "2026-08-06T10:00:00.000Z",
    },
  },

  "GET /api/base/fresh": {
    input: { minutes: 10, fundedOnly: true },
    inputSchema: {
      properties: {
        minutes: { type: "integer", minimum: 1, maximum: 60, description: "Optional. How far back to look, default 10" },
        limit: { type: "integer", minimum: 1, maximum: 50, description: "Optional. How many pools to return, default 15" },
        fundedOnly: { type: "boolean", description: "Optional. Drop pools nobody has added liquidity to yet" },
      },
    },
    output: {
      chain: "base",
      scope: "uniswap-v4",
      windowMinutes: 10,
      headBlock: 49648349,
      pools: [
        {
          poolId: "0xb2417a41cd75...",
          protocol: "uniswap-v4",
          token: "0x47d4126cb8...",
          tokenBasis: "quote-asset",
          pair: ["0x4200000000000000000000000000000000000006", "0x47d4126cb8..."],
          quote: "0x4200000000000000000000000000000000000006",
          quoteSymbol: "WETH",
          block: 49648342,
          createdAt: "2026-08-07T09:41:12.000Z",
          ageSeconds: 14,
          funded: true,
          launchTx: "0xd31d3b760a...",
          launchedBy: "0x51dfdeecdc...",
          hook: "0xbdf938149a...",
          hookPools: 21,
          feeMode: "dynamic",
          feeBps: null,
        },
      ],
      summary: { found: 10, funded: 10, bespokeHooks: 0, shown: 10 },
      method: "Read from the Uniswap v4 PoolManager's own Initialize log on Base...",
      notMeasured: "USD liquidity - v4 keeps every pool's tokens in one singleton...",
      at: "2026-08-07T09:41:26.000Z",
    },
  },

  "GET /api/base/radar/history": {
    input: { date: "2026-08-06" },
    inputSchema: {
      properties: {
        date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Optional. Snapshot day, default latest. History begins 2026-08-06" },
      },
    },
    output: {
      "chain": "base",
      "date": "2026-08-06",
      "at": "2026-08-06T10:57:00.000Z",
      "settlement": "0x9c41...b02a",
      "summary": {
        "found": 3,
        "checked": 3,
        "unchecked": 0,
        "highRisk": 1,
        "caution": 2,
        "insufficientData": 0,
        "clear": 0
      },
      "pools": [
        {
          "name": "openhuman / WETH",
          "pool": "0x74bb...dc77",
          "token": "0x74bb95da6692c34ee9755ac87ea10366653dbc77",
          "createdAt": "2026-08-05T13:02:05Z",
          "priceUsd": 0.0000047,
          "liquidityUsd": 68437,
          "volume24hUsd": 5.4,
          "safety": {
            "verdict": "high-risk",
            "failed": [
              "liquidity"
            ],
            "warnings": [
              "creator-stake"
            ],
            "unchecked": []
          }
        }
      ],
      "provenance": {
        "revision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "commit": "https://github.com/tevfikefeaydin/agenttoll/commit/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "raw": "https://raw.githubusercontent.com/tevfikefeaydin/agenttoll/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/data/scout/2026-08-06.json",
        "paidWith": null,
        "integrity": "Git revision pins the published bytes. A payment transaction does not authenticate a snapshot hash or its capture time."
      },
      "availableDates": {
        "first": "2026-08-06",
        "last": "2026-08-06",
        "count": 1
      }
    },
  },

  "GET /api/base/scorecard": {
    input: { days: 7 },
    inputSchema: {
      properties: {
        days: { type: "integer", minimum: 1, maximum: 30, description: "Optional. Latest published snapshots to compare, default 7; elapsed holding periods vary" },
      },
    },
    output: {
      "chain": "base",
      "windowDays": 7,
      "trackRecord": {
        "daysCovered": 7,
        "firstSnapshot": "2026-08-06",
        "lastSnapshot": "2026-08-12"
      },
      "cohorts": {
        "high-risk": {
          "count": 1,
          "priced": 0,
          "unavailable": 0,
          "liquidityGone": 1,
          "medianChangePct": null
        },
        "caution": {
          "count": 0,
          "priced": 0,
          "unavailable": 0,
          "liquidityGone": 0,
          "medianChangePct": null
        },
        "insufficient-data": {
          "count": 0,
          "priced": 0,
          "unavailable": 0,
          "liquidityGone": 0,
          "medianChangePct": null
        },
        "clear": {
          "count": 0,
          "priced": 0,
          "unavailable": 0,
          "liquidityGone": 0,
          "medianChangePct": null
        },
        "unassessed": {
          "count": 0,
          "priced": 0,
          "unavailable": 0,
          "liquidityGone": 0,
          "medianChangePct": null
        }
      },
      "tokens": [
        {
          "token": "0x74bb...dc77",
          "name": "openhuman / WETH",
          "flaggedOn": "2026-08-06",
          "verdictThen": "high-risk",
          "liquidityThenUsd": 68437,
          "liquidityNowUsd": 3,
          "priceChangePct": null,
          "liquidityGone": true,
          "outcome": "low-observed-liquidity"
        }
      ],
      "methodology": "First sightings in published samples; current deepest observed pool. liquidityGone is null when unavailable; true only for observed liquidity below $100. Medians use available quotes and varying holding periods.",
      "disclaimer": "A track record, not investment advice.",
      "at": "2026-08-12T10:00:00.000Z",
      "coverage": {
        "requestedDays": 7,
        "windowBasis": "latest-published-snapshots",
        "snapshotsListed": 7,
        "snapshotsLoaded": 7,
        "missingSnapshotDates": [],
        "windowFirstSnapshot": "2026-08-06",
        "windowLastSnapshot": "2026-08-12",
        "poolsObserved": 1,
        "poolsWithoutSafety": 0,
        "poolsWithoutToken": 0,
        "tokensObserved": 1,
        "tokensPriced": 0,
        "priceBatchesFailed": 0,
        "complete": false,
        "note": "Published radar samples with variable holding periods; missing quotes are not losses."
      },
      "provenance": {
        "revision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "commit": "https://github.com/tevfikefeaydin/agenttoll/commit/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "index": "https://raw.githubusercontent.com/tevfikefeaydin/agenttoll/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/data/scout/index.json",
        "integrity": "Git revision pins the published bytes. A payment transaction does not authenticate a snapshot hash or its capture time."
      }
    },
  },

  "GET /api/base/safety/:address": {
    ...address,
    output: {
      "chain": "base",
      "token": "0x940181a94a35a4569e4529a3cdfb74e38fd98631",
      "name": "Example Token",
      "symbol": "EXAMPLE",
      "verdict": "caution",
      "failed": [],
      "warnings": [
        "owner-powers",
        "liquidity"
      ],
      "unchecked": [
        "concentration",
        "liquidity",
        "creator-stake",
        "deployer"
      ],
      "checks": [
        {
          "id": "honeypot",
          "status": "pass",
          "detail": "Simulated buy and sell succeeded",
          "complete": true,
          "sources": [
            "goplus"
          ],
          "missing": [],
          "conflicts": []
        },
        {
          "id": "taxes",
          "status": "pass",
          "detail": "Both taxes measured at 0%",
          "complete": true,
          "sources": [
            "goplus"
          ],
          "missing": [],
          "conflicts": []
        },
        {
          "id": "verified",
          "status": "pass",
          "detail": "Source code verified",
          "complete": true,
          "sources": [
            "goplus"
          ],
          "missing": [],
          "conflicts": []
        },
        {
          "id": "owner-powers",
          "status": "warn",
          "detail": "Owner can mint",
          "complete": true,
          "sources": [
            "goplus"
          ],
          "missing": [],
          "conflicts": []
        },
        {
          "id": "concentration",
          "status": "unknown",
          "detail": "Holder shares unavailable",
          "complete": false,
          "sources": [
            "goplus"
          ],
          "missing": [
            "holders"
          ],
          "conflicts": []
        },
        {
          "id": "liquidity",
          "status": "warn",
          "detail": "Some removable liquidity detected; incomplete ownership",
          "complete": false,
          "sources": [
            "goplus"
          ],
          "missing": [
            "liquidity-share-total"
          ],
          "conflicts": []
        },
        {
          "id": "creator-stake",
          "status": "unknown",
          "detail": "Creator share unavailable",
          "complete": false,
          "sources": [
            "goplus"
          ],
          "missing": [
            "creator_percent"
          ],
          "conflicts": []
        },
        {
          "id": "deployer",
          "status": "unknown",
          "detail": "Explorer scam flag unavailable",
          "complete": false,
          "sources": [
            "goplus"
          ],
          "missing": [
            "flaggedScam"
          ],
          "conflicts": []
        }
      ],
      "deployer": {
        "address": "0xe83f922c34a1...",
        "basis": "contract-creator",
        "isContract": false,
        "txCount": 731,
        "balanceEth": 0.12094,
        "firstSeen": null,
        "ageHours": null,
        "flaggedScam": null
      },
      "holderCount": 748566,
      "listedOnCex": [
        "Coinbase"
      ],
      "sources": [
        "goplus",
        "honeypot.is"
      ],
      "disclaimer": "Automated checks against public data, not investment advice. Passing every check does not make a token safe.",
      "at": "2026-08-05T13:31:58.678Z",
      "coverage": {
        "complete": false,
        "completedChecks": 4,
        "totalChecks": 8
      },
      "sourceStatus": {
        "goplus": {
          "status": "partial",
          "fetchedAt": "2026-08-05T13:31:58.678Z",
          "durationMs": 100,
          "issues": [
            "creator_percent"
          ]
        },
        "honeypot.is": {
          "status": "ok",
          "fetchedAt": "2026-08-05T13:31:58.678Z",
          "durationMs": 100,
          "issues": []
        },
        "blockscout+rpc": {
          "status": "partial",
          "fetchedAt": "2026-08-05T13:31:58.678Z",
          "durationMs": 100,
          "issues": [
            "flaggedScam"
          ]
        }
      }
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
    output: {
      "query": "agenttoll.base.eth",
      "name": "agenttoll.base.eth",
      "address": "0xe553...56f8",
      "resolver": "0x426fA03f...",
      "records": {},
      "at": "2026-08-05T13:31:58.678Z",
      "registered": true
    },
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
      pools: [{ name: "BASED / ETH 1%", pool: "0x2acb...cac0", token: "0xb6bb786056c690e41b20a587573fd77aade2eb07", createdAt: "2026-08-05T13:01:33Z", priceUsd: 0.0000156, volume24hUsd: 19071.46, liquidityUsd: 14246.1 }],
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

  "GET /api/try/spread": {
    input: { asset: "usdt" },
    inputSchema: {
      properties: {
        asset: { type: "string", enum: ["btc", "usdt"], description: "Optional. Cross-rate asset, default btc" },
      },
    },
    output: {
      asset: "usdt",
      officialUsdTry: 47.2891,
      globalUsd: 0.999318,
      exchanges: [
        { name: "btcturk", try: 47.53, impliedUsd: 1.00509, spreadPct: 0.578, unavailable: false },
        { name: "paribu", try: 47.51, impliedUsd: 1.00466, spreadPct: 0.535, unavailable: false },
      ],
      at: "2026-08-05T13:31:58.678Z",
    },
  },

  "GET /api/watch/address/:address": {
    ...address,
    input: { since: "2026-08-05T08:40:01Z" },
    inputSchema: since,
    output: {
      "chain": "base",
      "address": "0xe553...56f8",
      "since": "2026-08-05T08:40:01Z",
      "count": 1,
      "events": [
        {
          "hash": "0x4893...3c91",
          "at": "2026-08-05T12:10:44Z",
          "direction": "in",
          "counterparty": "0x5f87...6f78",
          "ethValue": 0,
          "method": "transferWithAuthorization"
        }
      ],
      "cursor": "w1.<opaque-example-returned-by-server>",
      "at": "2026-08-05T13:31:58.678Z",
      "hasMore": false,
      "partial": false,
      "coverage": {
        "complete": true,
        "scope": "indexed-confirmed-transactions",
        "pagesRead": 1,
        "overlapSeconds": 120,
        "deduplicationLimit": 100,
        "replayPossible": false,
        "note": "Drain hasMore pages, then echo the cursor when polling. Deduplicate by hash; indexer gaps and older reorganizations are outside this coverage."
      }
    },
  },

  "GET /api/watch/radar": {
    input: { since: "2026-08-05T08:40:01Z" },
    inputSchema: since,
    output: {
      "chain": "base",
      "since": "2026-08-05T08:40:01Z",
      "count": 1,
      "pools": [
        {
          "name": "BASED / ETH 1%",
          "pool": "0x2acb...cac0",
          "token": "0xb6bb786056c690e41b20a587573fd77aade2eb07",
          "createdAt": "2026-08-05T13:01:33Z",
          "priceUsd": 0.0000156,
          "volume24hUsd": 19071.46,
          "liquidityUsd": 14246.1
        }
      ],
      "cursor": "2026-08-05T13:01:33Z",
      "at": "2026-08-05T13:31:58.678Z",
      "partial": true,
      "coverage": {
        "complete": false,
        "scope": "ranked-radar-listing",
        "source": "geckoterminal-new-pools",
        "observedAt": "2026-08-05T13:31:58.678Z",
        "note": "Limited ranked listing, not an exhaustive pool event stream."
      }
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
      "symbol": "eth",
      "usd": 1867.28,
      "ref": 1900,
      "changePct": -1.7221,
      "thresholdPct": 2,
      "triggered": false,
      "direction": "down",
      "at": "2026-08-05T13:31:58.678Z",
      "quoteCurrency": "USD",
      "assumptions": [],
      "source": "coingecko",
      "priceObservedAt": "2026-08-05T13:31:58.678Z"
    },
  },
};
