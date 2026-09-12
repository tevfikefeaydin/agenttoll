import { cached, fetchWithTimeout } from "./cache.js";
import { blockscoutFetch, fromSources } from "./sources.js";
import { requestContext, withSignal } from "../request-context.js";
import { MAX_TOLL_UNITS, parseStatsBaseline, type StatsBaseline, type StatsNetwork } from "./stats-baseline.js";
export type { StatsNetwork } from "./stats-baseline.js";

// Counts of small USDC transfers to payTo. These include tests and unsolicited
// transfers; the chain alone cannot prove an API call or organic customer sale.
//
// Two independent readings of the same truth, tried in order:
//   1. Blockscout's indexer — one paginated query, fast when it is healthy.
//   2. The chain itself — a committed baseline plus eth_getLogs for the blocks
//      since. Slower, but it only depends on a public RPC, and Blockscout has
//      now gone down (500s, then timeouts) three times in a month.
const NETWORKS = {
  base: { blockscout: "https://base.blockscout.com/api/v2", usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", rpcs: ["https://mainnet.base.org", "https://base-rpc.publicnode.com"] },
  "base-sepolia": { blockscout: "https://base-sepolia.blockscout.com/api/v2", usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", rpcs: ["https://sepolia.base.org"] },
} as const;

function defaultNetwork(): StatsNetwork {
  const network = process.env.NETWORK ?? "base-sepolia";
  if (network !== "base" && network !== "base-sepolia") throw new Error("Unsupported stats network");
  return network;
}

function recipient(payTo: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(payTo)) throw new Error("Invalid stats recipient address");
  return payTo.toLowerCase();
}
const MAX_PAGES = 20; // 50 transfers/page; raise when the tollbooth gets busy
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

async function fromBlockscout(payTo: string, network: StatsNetwork, signal: AbortSignal): Promise<Tally> {
  const { blockscout, usdc } = NETWORKS[network];
  const payers = new Map<string, { calls: number; usdc: bigint }>();
  let truncated = false;
  let params = "";
  let firstAt: string | null = null;
  let lastAt: string | null = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    // This feeds the homepage counter, so do not let an unhealthy upstream
    // keep a visitor staring at "reading the chain..." indefinitely.
    const res = await blockscoutFetch(
      `${blockscout}/addresses/${payTo}/token-transfers?type=ERC-20&filter=to&token=${usdc}${params}`,
      { headers: { Accept: "application/json" }, signal },
      STATS_UPSTREAM_TIMEOUT_MS,
      // One try only: reading the chain below is faster than a second attempt
      // against an indexer that just failed, and halves the wait on an outage.
      { retryWithKey: false },
    );
    const json = (await res.json()) as TransferPage;

    for (const item of json.items) {
      const value = BigInt(item.total?.value ?? "0");
      if (value <= 0n || value > MAX_TOLL_UNITS) continue;

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
// 10–50 blocks or gate archive reads behind a token. base.org cut its own
// ceiling to 2,000 blocks and answers HTTP 413 above it, which took this reading
// down entirely until the chunk size followed; publicnode holds the same range
// and is the second opinion, though only a shallow one: it answers 403 beyond
// roughly half a day back, so it covers the newest chunks and nothing older.
// drpc used to have that slot and no longer earns it — its free tier stops at
// 50 blocks, short of even one chunk. Nothing else free reads Base logs this
// far back at all, so base.org failing is the case worth degrading well for.
const CHUNK = 2_000; // the ceiling both remaining public providers enforce
const LANES = 3; // measured: three concurrent getLogs are clean, six draw 429s
const MAX_CHUNKS = 90; // ~4 days of catching up on a stale baseline
const SCAN_BUDGET_MS = 9_000; // stay under the platform's own request timeout

const hex = (n: number) => `0x${n.toString(16)}`;
const topicAddress = (addr: string) => `0x${addr.slice(2).toLowerCase().padStart(64, "0")}`;

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

async function logsRpc<T>(network: StatsNetwork, method: string, params: unknown[] = [], signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  const reading = fromSources<T>(
    `${network} rpc ${method}`,
    NETWORKS[network].rpcs.map((url) => ({
      name: new URL(url).host,
      load: async () => {
        signal?.throwIfAborted();
        const res = await fetchWithTimeout(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as { result?: T; error?: { message: string } };
        if (json.error) throw new Error(json.error.message);
        if (json.result === undefined) throw new Error("empty result");
        return json.result;
      },
    })),
  );
  return signal ? withSignal(reading, signal) : reading;
}

/** The chain's own head block. */
export async function latestBlock(network: StatsNetwork = defaultNetwork(), signal?: AbortSignal): Promise<number> {
  const result = await logsRpc<string>(network, "eth_blockNumber", [], signal);
  if (!/^0x[0-9a-f]+$/i.test(result)) throw new Error("Invalid head block");
  const block = parseInt(result, 16);
  if (!Number.isSafeInteger(block) || block < 0) throw new Error("Invalid head block");
  return block;
}

/** When a block was mined, as an ISO string. */
export async function blockMinedAt(block: number, network: StatsNetwork = defaultNetwork(), signal?: AbortSignal): Promise<string> {
  const b = await logsRpc<{ timestamp: string }>(network, "eth_getBlockByNumber", [hex(block), false], signal);
  return new Date(parseInt(b.timestamp, 16) * 1000).toISOString();
}

/** A canonical block boundary for resumable snapshots; finalized avoids the live tip. */
export async function blockCheckpoint(block: number | "finalized", network: StatsNetwork = defaultNetwork(), signal?: AbortSignal) {
  const result = await logsRpc<{ number: string; hash: string; timestamp: string }>(
    network, "eth_getBlockByNumber", [block === "finalized" ? block : hex(block), false], signal,
  );
  if (!result || !/^0x[0-9a-f]+$/i.test(result.number) || !/^0x[0-9a-f]{64}$/i.test(result.hash)
    || !/^0x[0-9a-f]+$/i.test(result.timestamp)) throw new Error("Invalid stats block checkpoint");
  const number = parseInt(result.number, 16);
  if (!Number.isSafeInteger(number) || (typeof block === "number" && number !== block)) throw new Error("Invalid stats block checkpoint number");
  return { block: number, hash: result.hash.toLowerCase(), at: new Date(parseInt(result.timestamp, 16) * 1000).toISOString() };
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
  network: StatsNetwork = defaultNetwork(),
  signal?: AbortSignal,
): Promise<TollLog[]> {
  const address = recipient(payTo);
  const logs = await logsRpc<RpcLog[]>(network, "eth_getLogs", [
    {
      fromBlock: hex(fromBlock),
      toBlock: hex(toBlock),
      address: NETWORKS[network].usdc,
      topics: [TRANSFER_TOPIC, null, topicAddress(address)],
    },
  ], signal);

  const tolls: TollLog[] = [];
  for (const log of logs) {
    const value = BigInt(log.data);
    if (value <= 0n || value > MAX_TOLL_UNITS) continue;
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
const baseline = (payTo: string, network: StatsNetwork, signal?: AbortSignal) => {
  const reading = cached(`stats:baseline:${network}:${payTo}`, 600_000, async () => {
    const res = await fetchWithTimeout(RAW_BASELINE, { signal });
    if (!res.ok) throw new Error(`Baseline store returned ${res.status}`);
    return parseStatsBaseline(await res.json(), payTo, network);
  });
  return signal ? withSignal(reading, signal) : reading;
};

/** One deadline covers pagination/failover/body reads, not one timer per fetch. */
async function withinBudget<T>(ms: number, read: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new DOMException("Stats budget expired", "TimeoutError")), ms);
  const callerSignal = requestContext.getStore()?.signal;
  const signal = callerSignal ? AbortSignal.any([deadline.signal, callerSignal]) : deadline.signal;
  try {
    return await read(signal);
  } finally {
    clearTimeout(timer);
    deadline.abort(); // Stop any discarded sibling requests from a failed lane.
  }
}

export async function fromChain(payTo: string, network: StatsNetwork = defaultNetwork()): Promise<Tally> {
  payTo = recipient(payTo);
  return withinBudget(SCAN_BUDGET_MS, (signal) => chainTally(payTo, network, signal));
}

async function chainTally(payTo: string, network: StatsNetwork, signal: AbortSignal): Promise<Tally> {
  const base = await baseline(payTo, network, signal);
  const payers = new Map(
    Object.entries(base.payers).map(
      ([addr, p]) => [addr.toLowerCase(), { calls: p.calls, usdc: BigInt(p.usdcUnits) }] as const,
    ),
  );

  let stopped: "budget" | "upstream" | null = null;
  // Asking for the head is itself an RPC call, and a dead provider fails here
  // before there is anything to scan. Leaving the head at the baseline block
  // skips the loop and reports the baseline as the floor it honestly is.
  let head = base.block;
  try {
    head = await latestBlock(network, signal);
  } catch {
    stopped = signal.aborted ? "budget" : "upstream";
  }
  if (head < base.block) throw new Error("Stats baseline is ahead of the current network head");
  let from = base.block + 1;
  let scannedThrough = base.block;
  let newestBlock = 0;
  let oldestBlock = Infinity;
  let chunks = 0;

  while (from <= head) {
    if (chunks >= MAX_CHUNKS || signal.aborted) {
      stopped = "budget";
      break;
    }
    // At 2,000 blocks a request, a day of drift is twenty-odd calls, so they go
    // out in small parallel lanes. The whole lane has to land before
    // scannedThrough moves: counting a later chunk while an earlier one is
    // still missing would leave a hole nothing downstream could see.
    const lane: Promise<TollLog[]>[] = [];
    let next = from;
    while (lane.length < LANES && next <= head) {
      const to = Math.min(next + CHUNK - 1, head);
      lane.push(scanTollLogs(payTo, next, to, network, signal));
      next = to + 1;
    }

    let landed: TollLog[][];
    try {
      landed = await Promise.all(lane);
    } catch {
      // One provider can read this far back, so its bad minute used to take the
      // whole answer down. The baseline plus the chunks that did land is a
      // floor: less than the truth, and far more than a 502.
      stopped = signal.aborted ? "budget" : "upstream";
      break;
    }

    for (const tolls of landed) {
      for (const toll of tolls) {
        const seen = payers.get(toll.sender) ?? { calls: 0, usdc: 0n };
        payers.set(toll.sender, { calls: seen.calls + 1, usdc: seen.usdc + toll.value });
        newestBlock = Math.max(newestBlock, toll.block);
        oldestBlock = Math.min(oldestBlock, toll.block);
      }
    }

    scannedThrough = next - 1;
    chunks += lane.length;
    from = next;
  }

  // Date only the bounds. A new undated transfer makes lastAt unknown; the
  // baseline's older timestamp would falsely describe it as the latest one.
  let firstAt = base.firstTollAt;
  let lastAt = base.lastTollAt;
  let timestampsMissing = false;
  if (newestBlock > 0) {
    lastAt = null;
    try {
      lastAt = await blockMinedAt(newestBlock, network, signal);
      if (Object.keys(base.payers).length === 0) {
        firstAt = oldestBlock === newestBlock ? lastAt : await blockMinedAt(oldestBlock, network, signal);
      }
    } catch {
      timestampsMissing = true;
    }
  }

  const notes: string[] = [];
  if (stopped) notes.push(`Blocks after ${scannedThrough} were not scanned — ${
    stopped === "budget" ? "the request's time or chunk budget was exhausted" : "the chain RPC would not answer"
  }. Counts are a floor, not a total.`);
  if (timestampsMissing) notes.push("Some transfer timestamps are unavailable; unknown bounds are null.");

  return {
    payers,
    firstAt,
    lastAt,
    partial: stopped !== null || timestampsMissing,
    source: `onchain (USDC Transfer logs via public ${network} RPC, from the compatible baseline at block ${base.block})`,
    note: notes.length ? notes.join(" ") : undefined,
  };
}

/**
 * An indexer reporting less than our committed baseline may be incomplete.
 * Fall back to RPC rather than silently reducing the displayed history.
 * A legacy baseline is trusted historical input, not a reorg-proof receipt.
 *
 * Best effort: if the baseline itself is unreachable, that is no reason to
 * reject an answer we have nothing to contradict.
 */
async function assertNotBehindBaseline(tally: Tally, payTo: string, network: StatsNetwork, signal: AbortSignal): Promise<void> {
  let base: StatsBaseline;
  try {
    base = await baseline(payTo, network, signal);
  } catch {
    return;
  }

  for (const [addr, recorded] of Object.entries(base.payers)) {
    const seen = tally.payers.get(addr.toLowerCase());
    if (!seen || seen.calls < recorded.calls || seen.usdc < BigInt(recorded.usdcUnits)) {
      throw new Error(
        `behind the committed baseline (${addr.slice(0, 10)}…: transfer count or USDC units are missing)`,
      );
    }
  }
}

// --- shared shape ----------------------------------------------------------

function summarise(t: Tally, payTo: string, network: StatsNetwork) {
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
    // Excludes only known test wallets. Other wallets can also be tests or
    // unsolicited senders, so these fields are not verified customer sales.
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
    network,
    payTo,
    source: t.source,
    at: new Date().toISOString(),
  };
}

export async function getStats(payTo: string, network: StatsNetwork = defaultNetwork()) {
  payTo = recipient(payTo);
  return cached(`stats:${network}:${payTo}`, 300_000, async () =>
    summarise(
      await fromSources<Tally>("stats", [
        {
          name: "blockscout",
          load: () => withinBudget(STATS_UPSTREAM_TIMEOUT_MS, (signal) => withSignal((async () => {
            const tally = await fromBlockscout(payTo, network, signal);
            await assertNotBehindBaseline(tally, payTo, network, signal);
            return tally;
          })(), signal)),
        },
        { name: "onchain-logs", load: () => fromChain(payTo, network) },
      ]),
      payTo, network,
    ),
  );
}
