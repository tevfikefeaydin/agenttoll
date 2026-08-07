import { decodeEventLog, parseAbiItem, toEventSelector } from "viem";
import { cached } from "./cache.js";
import { optionalInt } from "./params.js";
import { baseRpc } from "./sources.js";

/**
 * Pools read straight off Base, seconds after they exist.
 *
 * Everything else here goes through an indexer, which costs minutes. This
 * reads the chain's own pool-creation log, so a token shows up about a block
 * after it is born — and the token address is right there, ready for
 * /api/base/safety.
 *
 * Scope is Uniswap v4 on purpose. Measuring the window showed v4 carrying the
 * clear majority of new Base pools (16 of 19 in a 10-minute sample), and the
 * v4 log gives one uniform way to answer "did anyone actually fund this".
 * v2/v3/Aerodrome pools still arrive in /api/base/radar minutes later.
 */

const POOL_MANAGER = "0x498581ff718922c3f8e6a244956af099b2652b2b";
const INITIALIZE = parseAbiItem(
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
);
const MODIFY_LIQUIDITY = parseAbiItem(
  "event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)",
);

/** Base produces a block every 2 seconds, which is how ages are derived. */
const BLOCK_SECONDS = 2;
/** One cached read covers the widest window, then each caller slices it. */
const WINDOW_MINUTES = 60;
const DEFAULT_MINUTES = 10;
const MAX_MINUTES = 60;
const DEFAULT_LIMIT = 15;
/** v4 marks a dynamic-fee pool with this flag rather than a fee in bps. */
const DYNAMIC_FEE_FLAG = 0x800000;

/** The sides an agent is not shopping for: everything else is "the token". */
const QUOTES: Record<string, string> = {
  "0x0000000000000000000000000000000000000000": "ETH",
  "0x4200000000000000000000000000000000000006": "WETH",
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": "USDC",
  "0xfde4c96c8593536e31f229ea8f37b2ada2699bb2": "USDT",
  "0x50c5725949a6f0c72e6c4a641f24049a917db0cb": "DAI",
};

interface RawLog {
  data: `0x${string}`;
  topics: [`0x${string}`, ...`0x${string}`[]];
  blockNumber: `0x${string}`;
}

interface FreshPool {
  poolId: string;
  protocol: "uniswap-v4";
  /** The side being launched, or null when the pair is genuinely ambiguous. */
  token: string | null;
  tokenBasis: "quote-asset" | "inferred-from-frequency" | "ambiguous" | "both-quotes";
  pair: [string, string];
  quote: string | null;
  quoteSymbol: string | null;
  block: number;
  createdAt: string;
  ageSeconds: number;
  funded: boolean;
  hook: string;
  hookPools: number;
  feeMode: "dynamic" | "static";
  feeBps: number | null;
}

interface Window {
  pools: FreshPool[];
  headBlock: number;
  fromBlock: number;
  at: string;
}

const hex = (n: number | bigint) => `0x${BigInt(n).toString(16)}`;

async function readWindow(): Promise<Window> {
  const headHex = await baseRpc<string>("eth_blockNumber");
  const head = Number(BigInt(headHex));
  const fromBlock = head - (WINDOW_MINUTES * 60) / BLOCK_SECONDS;

  const headBlock = await baseRpc<{ timestamp: string }>("eth_getBlockByNumber", [headHex, false]);
  const headTime = Number(BigInt(headBlock.timestamp)) * 1000;

  const created = await baseRpc<RawLog[]>("eth_getLogs", [
    {
      fromBlock: hex(fromBlock),
      toBlock: "latest",
      address: POOL_MANAGER,
      topics: [toEventSelector(INITIALIZE)],
    },
  ]);

  const decoded = created.map((log) => {
    const { args } = decodeEventLog({ abi: [INITIALIZE], data: log.data, topics: log.topics }) as {
      args: {
        id: string;
        currency0: string;
        currency1: string;
        fee: number;
        hooks: string;
      };
    };
    return { ...args, block: Number(BigInt(log.blockNumber)) };
  });

  // One request answers "was this funded" for every pool in the window: v4
  // indexes ModifyLiquidity by pool id, and a topic slot accepts an array.
  const ids = decoded.map((d) => d.id);
  let funded = new Set<string>();
  if (ids.length) {
    const mods = await baseRpc<RawLog[]>("eth_getLogs", [
      {
        fromBlock: hex(fromBlock),
        toBlock: "latest",
        address: POOL_MANAGER,
        topics: [toEventSelector(MODIFY_LIQUIDITY), ids],
      },
    ]);
    funded = new Set(mods.map((m) => m.topics[1].toLowerCase()));
  }

  // A hook shared by many pools is a launchpad; a hook used exactly once is
  // bespoke code shipped with a brand-new token, which is where a contract
  // that blocks selling would live. Counted over the whole window, not the
  // caller's slice, so the number means the same thing at any window size.
  const hookUse = new Map<string, number>();
  for (const d of decoded) {
    const hook = d.hooks.toLowerCase();
    hookUse.set(hook, (hookUse.get(hook) ?? 0) + 1);
  }

  // Not every launch pairs against ETH or USDC: some launchpads back their
  // tokens with their own asset, or with another of their tokens. Counting how
  // often each side shows up in the window separates them without guessing —
  // the backing asset recurs, the token being launched does not.
  const currencyUse = new Map<string, number>();
  for (const d of decoded) {
    for (const c of [d.currency0.toLowerCase(), d.currency1.toLowerCase()]) {
      currencyUse.set(c, (currencyUse.get(c) ?? 0) + 1);
    }
  }

  const pools: FreshPool[] = decoded.map((d) => {
    const c0 = d.currency0.toLowerCase();
    const c1 = d.currency1.toLowerCase();
    const c0Quote = c0 in QUOTES;
    const c1Quote = c1 in QUOTES;

    let token: string | null;
    let quote: string | null;
    let tokenBasis: FreshPool["tokenBasis"];
    if (c0Quote !== c1Quote) {
      quote = c0Quote ? c0 : c1;
      token = c0Quote ? c1 : c0;
      tokenBasis = "quote-asset";
    } else if (c0Quote && c1Quote) {
      // Two majors paired together is not a launch at all.
      token = null;
      quote = null;
      tokenBasis = "both-quotes";
    } else {
      const u0 = currencyUse.get(c0) ?? 1;
      const u1 = currencyUse.get(c1) ?? 1;
      if (u0 === u1) {
        // Both sides equally new: saying which one launched would be a guess.
        token = null;
        quote = null;
        tokenBasis = "ambiguous";
      } else {
        quote = u0 > u1 ? c0 : c1;
        token = u0 > u1 ? c1 : c0;
        tokenBasis = "inferred-from-frequency";
      }
    }

    const dynamic = (d.fee & DYNAMIC_FEE_FLAG) !== 0;
    const age = (Number(BigInt(headHex)) - d.block) * BLOCK_SECONDS;
    return {
      poolId: d.id,
      protocol: "uniswap-v4",
      token,
      tokenBasis,
      pair: [c0, c1],
      quote,
      quoteSymbol: quote ? (QUOTES[quote] ?? null) : null,
      block: d.block,
      createdAt: new Date(headTime - age * 1000).toISOString(),
      ageSeconds: age,
      funded: funded.has(d.id.toLowerCase()),
      hook: d.hooks.toLowerCase(),
      hookPools: hookUse.get(d.hooks.toLowerCase()) ?? 1,
      feeMode: dynamic ? "dynamic" : "static",
      feeBps: dynamic ? null : d.fee / 100,
    };
  });

  pools.sort((a, b) => a.ageSeconds - b.ageSeconds);
  return { pools, headBlock: head, fromBlock, at: new Date().toISOString() };
}

/**
 * `minutes` is how far back to look (default 10, max 60) and `limit` caps the
 * list. `fundedOnly` drops pools nobody has put anything into yet.
 */
export async function getFreshPools(
  minutesRaw?: string,
  limitRaw?: string,
  fundedOnlyRaw?: string,
) {
  const minutes = optionalInt("minutes", minutesRaw, { min: 1, max: MAX_MINUTES }) ?? DEFAULT_MINUTES;
  const limit = optionalInt("limit", limitRaw, { min: 1, max: 50 }) ?? DEFAULT_LIMIT;
  const fundedOnly = fundedOnlyRaw === undefined ? false : fundedOnlyRaw !== "false";

  // Short TTL: this endpoint's whole point is that the answer is seconds old.
  const window = await cached("fresh", 30_000, readWindow);

  const cutoff = minutes * 60;
  const inWindow = window.pools.filter((p) => p.ageSeconds <= cutoff);
  const pools = (fundedOnly ? inWindow.filter((p) => p.funded) : inWindow).slice(0, limit);

  return {
    chain: "base",
    scope: "uniswap-v4",
    windowMinutes: minutes,
    headBlock: window.headBlock,
    pools,
    summary: {
      found: inWindow.length,
      funded: inWindow.filter((p) => p.funded).length,
      bespokeHooks: inWindow.filter((p) => p.hookPools === 1).length,
      shown: pools.length,
    },
    method:
      "Read from the Uniswap v4 PoolManager's own Initialize log on Base, so a pool appears about a block after it exists. `funded` comes from ModifyLiquidity events for the same pool id. `hookPools` counts how many pools in the last hour share that hook: a high count is a launchpad, exactly 1 is bespoke code shipped with this token. `tokenBasis` says how the launched side was identified — against a known quote asset, or inferred because the other side recurs across the window as a backing asset; when both sides are equally new it stays null rather than guessing, and `pair` always carries both. Ages are derived from block height at 2s per block.",
    notMeasured:
      "USD liquidity. v4 keeps every pool's tokens in one singleton contract, and the pool's liquidity at the current tick reads 0 for most fresh launches, so any USD figure here would be invented. /api/base/radar carries real liquidity and volume once an indexer has the pool, minutes later.",
    at: window.at,
  };
}
