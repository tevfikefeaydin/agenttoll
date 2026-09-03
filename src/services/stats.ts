import { cached, fetchWithTimeout } from "./cache.js";
import { blockscoutFetch, fromSources } from "./sources.js";

// Toll stats derived straight from the chain: every payment is a USDC Transfer
// to the payTo address, so the counter cannot lie and needs no database.
//
// Two independent readings of the same truth, tried in order:
//   1. Blockscout's indexer — one paginated query, fast when it is healthy.
//   2. The chain itself — a committed baseline plus eth_getLogs for the blocks
//      since. Slower, but it only depends on a public RPC, and Blockscout has
//      now gone down (500s, then timeouts) three times in a month.
const MAINNET = (process.env.NETWORK ?? "base-sepolia") === "base";
const BLOCKSCOUT = MAINNET
  ? "https://base.blockscout.com/api/v2"
  : "https://base-sepolia.blockscout.com/api/v2";
const USDC = MAINNET
  ? "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
  : "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const MAX_PAGES = 20; // 50 transfers/page; raise when the tollbooth gets busy
// Tolls are micro-payments; anything bigger is the owner funding the wallet.
const MAX_TOLL_UNITS = 50_000n; // $0.05
// Blockscout normally answers this query in about 4–5s. Leave enough headroom
// for a healthy response while keeping the homepage counter bounded on outages.
const STATS_UPSTREAM_TIMEOUT_MS = 8_000;

// The wallets we run our own tests from. Counted like any other payer, but
// reported separately so "did anyone else pay yet" is answerable at a glance.
// Retired wallets stay listed: their historical calls remain ours forever.
const OWN_TEST_WALLETS = new Set([
  "0x5f871f89b13f5c7f570a765aa54c211323f36f78", // retired 2026-08-06
  "0x29d7837a1c19890d2ab123999e9cf8bfe40985b0",
]);

/** What either reading produces: who paid, how much, and how sure we are. */
interface Tally {
  payers: Map<string, { calls: number; usdc: bigint }>;
  firstAt: string | null;
  lastAt: string | null;
  source: string;
  truncated?: boolean;
  partial?: boolean;
  note?: string;
}

// --- 1. Blockscout ---------------------------------------------------------

interface TransferPage {
  items: { total?: { value?: string }; from?: { hash?: string }; timestamp?: string }[];
  next_page_params: Record<string, string | number> | null;
}

async function fromBlockscout(payTo: string): Promise<Tally> {
  const payers = new Map<string, { calls: number; usdc: bigint }>();
  let truncated = false;
  let params = "";
  let firstAt: string | null = null;
  let lastAt: string | null = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    // This feeds the homepage counter, so do not let an unhealthy upstream
    // keep a visitor staring at "reading the chain..." indefinitely.
    const res = await blockscoutFetch(
      `${BLOCKSCOUT}/addresses/${payTo}/token-transfers?type=ERC-20&filter=to&token=${USDC}${params}`,
      { headers: { Accept: "application/json" } },
      STATS_UPSTREAM_TIMEOUT_MS,
      // One try only: reading the chain below is faster than a second attempt
      // against an indexer that just failed, and halves the wait on an outage.
      { retryWithKey: false },
    );
    const json = (await res.json()) as TransferPage;

    for (const item of json.items) {
      const value = BigInt(item.total?.value ?? "0");
      if (value === 0n || value > MAX_TOLL_UNITS) continue;

      const from = item.from?.hash?.toLowerCase();
      if (from) {
        const seen = payers.get(from) ?? { calls: 0, usdc: 0n };
        payers.set(from, { calls: seen.calls + 1, usdc: seen.usdc + value });
      }
      // Blockscout returns newest first, so the last one we see is the oldest.
      if (item.timestamp) {
        lastAt ??= item.timestamp;
        firstAt = item.timestamp;
      }
    }

    if (!json.next_page_params) break;
    if (page === MAX_PAGES - 1) truncated = true;
    params =
      "&" +
      Object.entries(json.next_page_params)
        .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
        .join("&");
  }

  return {
    payers,
    firstAt,
    lastAt,
    truncated,
    source: "onchain (USDC transfers to the payTo address, via Blockscout)",
  };
}

// --- 2. The chain itself ---------------------------------------------------

const RAW_BASELINE =
  "https://raw.githubusercontent.com/tevfikefeaydin/agenttoll/main/data/stats.json";

// keccak("Transfer(address,address,uint256)")
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
// Public RPCs that actually answer eth_getLogs over a useful range: most cap at
// 10–50 blocks or gate archive reads behind a token. base.org is the dependable
// one; drpc is a last-ditch that often times out on its free tier, and costs
// nothing to list because fromSources only reaches it if base.org fails.
const LOG_RPCS = ["https://mainnet.base.org", "https://base.drpc.org"];
const CHUNK = 10_000; // every provider that works caps the range here
const MAX_CHUNKS = 60; // ~12 days of catching up on a stale baseline
const SCAN_BUDGET_MS = 9_000; // stay under the platform's own request timeout

const hex = (n: number) => `0x${n.toString(16)}`;
const topicAddress = (addr: string) => `0x${addr.slice(2).toLowerCase().padStart(64, "0")}`;

interface BaselineFile {
  block: number;
  firstTollAt: string | null;
  lastTollAt: string | null;
  payers: Record<string, { calls: number; usdcUnits: string }>;
}

interface RpcLog {
  data: string;
  topics: string[];
  blockNumber: string;
}

/** One toll, as read off a Transfer log. */
export interface TollLog {
  sender: string;
  value: bigint;
  block: number;
}

async function logsRpc<T>(method: string, params: unknown[] = []): Promise<T> {
  return fromSources<T>(
    `base rpc ${method}`,
    LOG_RPCS.map((url) => ({
      name: new URL(url).host,
      load: async () => {
        const res = await fetchWithTimeout(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as { result?: T; error?: { message: string } };
        if (json.error) throw new Error(json.error.message);
        if (json.result === undefined) throw new Error("empty result");
        return json.result;
      },
    })),
  );
}

/** The chain's own head block. */
export const latestBlock = async () => parseInt(await logsRpc<string>("eth_blockNumber"), 16);

/** When a block was mined, as an ISO string. */
export async function blockMinedAt(block: number): Promise<string> {
  const b = await logsRpc<{ timestamp: string }>("eth_getBlockByNumber", [hex(block), false]);
  return new Date(parseInt(b.timestamp, 16) * 1000).toISOString();
}

/**
 * One chunk of USDC Transfer logs into payTo, already filtered down to tolls.
 * The live fallback and the CI baseline both read the chain through this, so
 * "what counts as a toll" can never drift between the two.
 */
export async function scanTollLogs(
  payTo: string,
  fromBlock: number,
  toBlock: number,
): Promise<TollLog[]> {
  const logs = await logsRpc<RpcLog[]>("eth_getLogs", [
    {
      fromBlock: hex(fromBlock),
      toBlock: hex(toBlock),
      address: USDC,
      topics: [TRANSFER_TOPIC, null, topicAddress(payTo)],
    },
  ]);

  const tolls: TollLog[] = [];
  for (const log of logs) {
    const value = BigInt(log.data);
    if (value === 0n || value > MAX_TOLL_UNITS) continue;
    tolls.push({
      sender: `0x${log.topics[1].slice(26)}`.toLowerCase(),
      value,
      block: parseInt(log.blockNumber, 16),
    });
  }
  return tolls;
}

export const LOG_CHUNK = CHUNK;

/**
 * The committed baseline: every toll up to a known block, refreshed daily by
 * CI. Scanning the whole history live would be ~150 sequential getLogs calls
 * and grows with the chain; this keeps the live part to the last day or so.
 */
const baseline = () =>
  cached("stats:baseline", 600_000, async () => {
    const res = await fetchWithTimeout(RAW_BASELINE);
    if (!res.ok) throw new Error(`Baseline store returned ${res.status}`);
    return (await res.json()) as BaselineFile;
  });

export async function fromChain(payTo: string): Promise<Tally> {
  const base = await baseline();
  const payers = new Map(
    Object.entries(base.payers).map(
      ([addr, p]) => [addr.toLowerCase(), { calls: p.calls, usdc: BigInt(p.usdcUnits) }] as const,
    ),
  );

  const head = await latestBlock();
  const started = Date.now();
  let from = base.block + 1;
  let scannedThrough = base.block;
  let newestBlock = 0;
  let chunks = 0;
  let partial = false;

  while (from <= head) {
    if (chunks >= MAX_CHUNKS || Date.now() - started > SCAN_BUDGET_MS) {
      partial = true;
      break;
    }
    const to = Math.min(from + CHUNK - 1, head);
    for (const toll of await scanTollLogs(payTo, from, to)) {
      const seen = payers.get(toll.sender) ?? { calls: 0, usdc: 0n };
      payers.set(toll.sender, { calls: seen.calls + 1, usdc: seen.usdc + toll.value });
      newestBlock = Math.max(newestBlock, toll.block);
    }

    scannedThrough = to;
    chunks += 1;
    from = to + 1;
  }

  // One extra call buys the only timestamp the response needs; dating every
  // log would cost a request per block for a field nobody reads per-payer.
  const lastAt = newestBlock > 0 ? await blockMinedAt(newestBlock) : base.lastTollAt;

  return {
    payers,
    firstAt: base.firstTollAt,
    lastAt,
    partial,
    source: `onchain (USDC Transfer logs via ${new URL(LOG_RPCS[0]).host}, from the committed baseline at block ${base.block})`,
    note: partial
      ? `Blocks after ${scannedThrough} were not scanned — the baseline is further behind than one request can catch up. Counts are a floor, not a total.`
      : undefined,
  };
}

// --- shared shape ----------------------------------------------------------

function summarise(t: Tally) {
  let count = 0;
  let revenue = 0n;
  for (const p of t.payers.values()) {
    count += p.calls;
    revenue += p.usdc;
  }

  const external = [...t.payers.entries()].filter(([addr]) => !OWN_TEST_WALLETS.has(addr));
  const externalCalls = external.reduce((sum, [, p]) => sum + p.calls, 0);
  const externalRevenue = external.reduce((sum, [, p]) => sum + p.usdc, 0n);

  return {
    tollsCollected: count,
    revenueUsdc: Number(revenue) / 1e6,
    uniquePayers: t.payers.size,
    // Everything above minus our own test wallet: the honest adoption signal.
    externalPayers: external.length,
    externalTolls: externalCalls,
    externalRevenueUsdc: Number(externalRevenue) / 1e6,
    topPayers: [...t.payers.entries()]
      .sort((a, b) => b[1].calls - a[1].calls)
      .slice(0, 5)
      .map(([address, p]) => ({
        address,
        calls: p.calls,
        usdc: Number(p.usdc) / 1e6,
        self: OWN_TEST_WALLETS.has(address),
      })),
    firstTollAt: t.firstAt,
    lastTollAt: t.lastAt,
    truncated: t.truncated ?? false,
    ...(t.partial ? { partial: true, note: t.note } : {}),
    network: MAINNET ? "base" : "base-sepolia",
    source: t.source,
    at: new Date().toISOString(),
  };
}

export async function getStats(payTo: string) {
  return cached("stats", 300_000, async () =>
    summarise(
      await fromSources<Tally>("stats", [
        { name: "blockscout", load: () => fromBlockscout(payTo) },
        { name: "onchain-logs", load: () => fromChain(payTo) },
      ]),
    ),
  );
}
