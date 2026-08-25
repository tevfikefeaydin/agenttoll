import { encodeFunctionData, decodeFunctionResult, parseAbi } from "viem";
import { cached, fetchWithTimeout } from "./cache.js";
import { badRequest } from "./errors.js";
import { optionalInt, optionalNumber } from "./params.js";
import { primaryName } from "./basename.js";
import { getPrice } from "./prices.js";
import { baseRpc, blockscoutFetch, fromSources } from "./sources.js";

/**
 * What an address actually holds on Base, valued in USD.
 *
 * The hard part is not the balances, it is the honesty: a portfolio that
 * quietly omits holdings is worse than no portfolio at all. So every reply says
 * which source answered, how many tokens fell below the caller's floor, and how
 * many could not be priced — and the degraded path marks itself `partial`.
 */

const DEFAULT_MIN_VALUE_USD = 1;
const DEFAULT_LIMIT = 20;

export interface Holding {
  symbol: string;
  name: string;
  address: string;
  balance: number;
  priceUsd: number;
  valueUsd: number;
}

interface Holdings {
  holdings: Holding[];
  unpriced: number;
  source: string;
  /** Set when the source could only see part of what the address holds. */
  incomplete?: string;
}

/**
 * Below this the tail is airdrop dust, so paging further buys nothing. It is
 * deliberately not the caller's floor: the caller's floor filters the answer,
 * this one decides how much of the chain we read, and keeping them separate is
 * what lets one cached snapshot serve every floor.
 */
const DUST_USD = 1;
const MAX_PAGES = 3;

/** Balances are integers in token units; decimals turn them into amounts. */
const toAmount = (raw: string, decimals: number) => Number(raw) / 10 ** decimals;

// ---------------------------------------------------------------------------
// Primary source: the Base explorer's indexed balances, which already carry a
// price and a spam reputation for each token.
// ---------------------------------------------------------------------------

interface BlockscoutEntry {
  value: string;
  token: {
    address_hash: string;
    name: string | null;
    symbol: string | null;
    decimals: string | null;
    exchange_rate: string | null;
    reputation: string | null;
  };
}

/**
 * The explorer returns 50 tokens a page, largest fiat value first. We follow
 * pages only while the tail is still worth something, so an ordinary wallet
 * costs one request and a whale costs two — and if even three pages have not
 * reached dust, the reply says so rather than pretending the list is whole.
 */
async function fromBlockscout(address: string): Promise<Holdings> {
  const base = `https://base.blockscout.com/api/v2/addresses/${address}/tokens?type=ERC-20`;
  const items: BlockscoutEntry[] = [];
  let url = base;
  let truncated = false;

  for (let page = 1; ; page++) {
    const res = await blockscoutFetch(url, { headers: { Accept: "application/json" } });
    const json = (await res.json()) as {
      items?: BlockscoutEntry[];
      next_page_params?: Record<string, unknown> | null;
    };
    if (!Array.isArray(json.items)) throw new Error("indexer returned no items array");
    items.push(...json.items);

    const next = json.next_page_params;
    if (!next || !json.items.length) break;
    // Sorted descending, so the last row on the page bounds everything after it.
    const tail = Number(next.fiat_value);
    if (!Number.isFinite(tail) || tail < DUST_USD) break;
    if (page >= MAX_PAGES) {
      truncated = true;
      break;
    }
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(next)) {
      if (value !== null && value !== undefined) params.set(key, String(value));
    }
    url = `${base}&${params}`;
  }

  let unpriced = 0;
  const holdings: Holding[] = [];
  for (const { value, token } of items) {
    // The explorer flags known-bad contracts; there is no reason to price them.
    if (token.reputation === "scam") continue;
    const decimals = Number(token.decimals);
    const price = Number(token.exchange_rate);
    // decimals and exchange_rate are both nullable, and a token missing either
    // cannot be valued — counting them is more useful than dropping them
    // silently, because the caller can see their picture is incomplete.
    if (!Number.isFinite(decimals) || token.decimals === null || !Number.isFinite(price) || price <= 0) {
      unpriced++;
      continue;
    }
    const balance = toAmount(value, decimals);
    if (!(balance > 0)) continue;
    holdings.push({
      symbol: token.symbol ?? "?",
      name: token.name ?? "?",
      address: token.address_hash.toLowerCase(),
      balance,
      priceUsd: price,
      valueUsd: balance * price,
    });
  }
  return {
    holdings,
    unpriced,
    source: "blockscout",
    incomplete: truncated
      ? `This address holds more than ${MAX_PAGES * 50} priced tokens; the largest ${MAX_PAGES * 50} are listed and the rest are not counted in the total.`
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// Fallback: read balances straight off the chain. Without an indexer we cannot
// enumerate what an address holds, so this covers a fixed list of the tokens
// that carry most of Base's value — a partial answer, clearly labelled.
// ---------------------------------------------------------------------------

const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";

// Address and decimals verified against the Base explorer.
const MAJOR_TOKENS: { symbol: string; name: string; address: string; decimals: number }[] = [
  { symbol: "WETH", name: "Wrapped Ether", address: "0x4200000000000000000000000000000000000006", decimals: 18 },
  { symbol: "USDC", name: "USD Coin", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 },
  { symbol: "USDbC", name: "USD Base Coin", address: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA", decimals: 6 },
  { symbol: "USDT", name: "Tether USD", address: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", decimals: 6 },
  { symbol: "DAI", name: "Dai Stablecoin", address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", decimals: 18 },
  { symbol: "EURC", name: "Euro Coin", address: "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42", decimals: 6 },
  { symbol: "cbBTC", name: "Coinbase Wrapped BTC", address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", decimals: 8 },
  { symbol: "cbETH", name: "Coinbase Wrapped Staked ETH", address: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22", decimals: 18 },
  { symbol: "wstETH", name: "Wrapped liquid staked Ether", address: "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452", decimals: 18 },
  { symbol: "rETH", name: "Rocket Pool ETH", address: "0xB6fe221Fe9EeF5aBa221c348bA20A1Bf5e73624c", decimals: 18 },
  { symbol: "AERO", name: "Aerodrome", address: "0x940181a94A35A4569E4529A3CDfB74e38FD98631", decimals: 18 },
  { symbol: "DEGEN", name: "Degen", address: "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed", decimals: 18 },
  { symbol: "VIRTUAL", name: "Virtual Protocol", address: "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b", decimals: 18 },
  { symbol: "BRETT", name: "Brett", address: "0x532f27101965dd16442E59d40670FaF5eBB142E4", decimals: 18 },
  { symbol: "TOSHI", name: "Toshi", address: "0xAC1Bd2486aAf3B5C0fc3Fd868558b082a531B2B4", decimals: 18 },
  { symbol: "MORPHO", name: "Morpho Token", address: "0xBAa5CC21fd487B8Fcc2F632f3F4E8D37262a0842", decimals: 18 },
  { symbol: "WELL", name: "Moonwell", address: "0xA88594D404727625A9437C3f886C7643872296AE", decimals: 18 },
];

const ERC20_ABI = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const MULTICALL3_ABI = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call3[] calls) payable returns (Result[])",
]);

/** DefiLlama prices the whole list in one keyless request. */
async function llamaPrices(addresses: string[]): Promise<Record<string, number>> {
  const ids = addresses.map((a) => `base:${a}`).join(",");
  const res = await fetchWithTimeout(`https://coins.llama.fi/prices/current/${ids}`);
  if (!res.ok) throw new Error(`Price source returned ${res.status}`);
  const coins = ((await res.json()) as { coins?: Record<string, { price?: number }> }).coins ?? {};
  const prices: Record<string, number> = {};
  for (const [key, entry] of Object.entries(coins)) {
    if (entry?.price) prices[key.replace(/^base:/, "").toLowerCase()] = entry.price;
  }
  return prices;
}

async function fromChain(address: string): Promise<Holdings> {
  const calls = MAJOR_TOKENS.map((token) => ({
    target: token.address as `0x${string}`,
    allowFailure: true,
    callData: encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [address as `0x${string}`],
    }),
  }));
  const data = encodeFunctionData({
    abi: MULTICALL3_ABI,
    functionName: "aggregate3",
    args: [calls],
  });
  const raw = await baseRpc<`0x${string}`>("eth_call", [{ to: MULTICALL3, data }, "latest"]);
  const results = decodeFunctionResult({
    abi: MULTICALL3_ABI,
    functionName: "aggregate3",
    data: raw,
  }) as readonly { success: boolean; returnData: `0x${string}` }[];

  const held = MAJOR_TOKENS.map((token, i) => {
    const result = results[i];
    if (!result?.success || result.returnData === "0x") return null;
    const balance = toAmount(BigInt(result.returnData).toString(), token.decimals);
    return balance > 0 ? { token, balance } : null;
  }).filter((entry): entry is { token: (typeof MAJOR_TOKENS)[number]; balance: number } => entry !== null);

  const incomplete =
    "Degraded source: the indexer was unavailable, so balances were read straight off the chain for major Base tokens only. Smaller holdings are missing.";
  if (!held.length) {
    return { holdings: [], unpriced: 0, source: "multicall3", incomplete };
  }

  const prices = await llamaPrices(held.map((h) => h.token.address.toLowerCase()));
  let unpriced = 0;
  const holdings: Holding[] = [];
  for (const { token, balance } of held) {
    const price = prices[token.address.toLowerCase()];
    if (!price) {
      unpriced++;
      continue;
    }
    holdings.push({
      symbol: token.symbol,
      name: token.name,
      address: token.address.toLowerCase(),
      balance,
      priceUsd: price,
      valueUsd: balance * price,
    });
  }
  return { holdings, unpriced, source: "multicall3+defillama", incomplete };
}

// ---------------------------------------------------------------------------

/**
 * `minValue` sets the USD floor that keeps airdropped spam out of the answer
 * (default $1) and `limit` caps the list (default 20, largest first).
 */
export async function getPortfolio(
  address: string,
  minValueRaw?: string,
  limitRaw?: string,
) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    badRequest("Invalid address — expected 0x + 40 hex chars");
  }
  const minValueUsd =
    optionalNumber("minValue", minValueRaw, { min: 0, max: 1_000_000_000 }) ??
    DEFAULT_MIN_VALUE_USD;
  const limit = optionalInt("limit", limitRaw, { min: 1, max: 50 }) ?? DEFAULT_LIMIT;
  const addr = address.toLowerCase();

  const snapshot = await cached(`portfolio:${addr}`, 30_000, async () => {
    const [balanceHex, eth, tokens, basename] = await Promise.all([
      baseRpc<string>("eth_getBalance", [addr, "latest"]),
      getPrice("eth"),
      fromSources<Holdings>(`portfolio ${addr}`, [
        { name: "blockscout", load: () => fromBlockscout(addr) },
        { name: "multicall3", load: () => fromChain(addr) },
      ]),
      // Best-effort: an address without a primary name still returns fine.
      primaryName(addr),
    ]);
    const ethBalance = Number(BigInt(balanceHex)) / 1e18;
    return {
      basename,
      native: {
        symbol: "ETH",
        balance: ethBalance,
        priceUsd: eth.usd,
        valueUsd: ethBalance * eth.usd,
      },
      tokens,
      at: new Date().toISOString(),
    };
  });

  const priced = [...snapshot.tokens.holdings].sort((a, b) => b.valueUsd - a.valueUsd);
  const above = priced.filter((h) => h.valueUsd >= minValueUsd);
  const tokens = above.slice(0, limit).map((h) => ({
    ...h,
    balance: Number(h.balance.toPrecision(12)),
    priceUsd: Number(h.priceUsd.toPrecision(8)),
    valueUsd: Number(h.valueUsd.toFixed(2)),
  }));

  // The total covers everything at or above the floor, so the listed rows and
  // the total always agree even when `limit` trims the tail.
  const totalUsd = above.reduce((sum, h) => sum + h.valueUsd, snapshot.native.valueUsd);

  return {
    chain: "base",
    address: addr,
    basename: snapshot.basename,
    native: {
      ...snapshot.native,
      balance: Number(snapshot.native.balance.toPrecision(12)),
      valueUsd: Number(snapshot.native.valueUsd.toFixed(2)),
    },
    tokens,
    totalUsd: Number(totalUsd.toFixed(2)),
    tokenCount: above.length,
    shown: tokens.length,
    hiddenBelowFloor: priced.length - above.length,
    unpriced: snapshot.tokens.unpriced,
    minValueUsd,
    source: snapshot.tokens.source,
    ...(snapshot.tokens.incomplete
      ? { partial: true, note: snapshot.tokens.incomplete }
      : {}),
    at: snapshot.at,
  };
}
