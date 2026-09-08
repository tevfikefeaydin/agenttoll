import { cached } from "./cache.js";
import { badRequest } from "./errors.js";
import { getPrice } from "./prices.js";
import { getNewTokenRadar } from "./radar.js";
import { blockscoutFetch } from "./sources.js";
import { deflateRawSync, inflateRawSync } from "node:zlib";

// Stateless "what changed since I last asked" endpoints. The agent keeps the
// cursor, so the server stores nothing and every reply is verifiable.
// Market data is always Base mainnet; NETWORK controls payment settlement.
const BLOCKSCOUT = "https://base.blockscout.com/api/v2";
const PAGE_SIZE = 50;
const OVERLAP_MS = 120_000;
const MAX_SEEN = 100;
const MAX_CURSOR_LENGTH = 8_000;

function parseSince(since?: string): number {
  if (!since) return 0;
  const t = Date.parse(since);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(since) || !Number.isFinite(t) || t < 0) badRequest("Invalid 'since' — pass the cursor from the previous reply or an ISO timestamp");
  return t;
}

interface PagePosition { block_number: number; index: number; items_count: number }
interface ActivityCursor {
  v: 1;
  address: string;
  floor: number;
  watermark: number;
  next: PagePosition | null;
  seen: [string, number][];
  replayPossible: boolean;
}

const validTime = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 8_640_000_000_000_000;

function pagePosition(value: unknown): PagePosition | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid pagination position");
  const obj = value as Record<string, unknown>;
  // Blockscout also supplies fields for optional fee/value/pending sorts.
  // Our confirmed feed keeps only its default block/index position.
  if (Object.keys(obj).some((key) => !["block_number", "index", "items_count", "fee", "value", "hash", "inserted_at"].includes(key))) throw new Error("Invalid pagination fields");
  const position = { block_number: Number(obj.block_number), index: Number(obj.index), items_count: Number(obj.items_count) };
  if (![position.block_number, position.index, position.items_count].every((n) => Number.isSafeInteger(n) && n >= 0)
    || position.items_count > PAGE_SIZE) throw new Error("Invalid pagination position");
  return position;
}

function readCursor(address: string, since?: string): ActivityCursor {
  if (!since?.startsWith("w1.")) {
    if (since && since.length > MAX_CURSOR_LENGTH) badRequest("Invalid 'since' cursor");
    const floor = parseSince(since);
    return { v: 1, address, floor, watermark: floor, next: null, seen: [], replayPossible: false };
  }
  try {
    if (since.length > MAX_CURSOR_LENGTH || !/^w1\.[A-Za-z0-9_-]+$/.test(since)) throw new Error();
    const value = JSON.parse(inflateRawSync(Buffer.from(since.slice(3), "base64url"), { maxOutputLength: 16_000 }).toString()) as ActivityCursor;
    if (value.v !== 1 || value.address !== address || !validTime(value.floor) || !validTime(value.watermark)
      || value.floor > value.watermark || typeof value.replayPossible !== "boolean"
      || !Array.isArray(value.seen) || value.seen.length > MAX_SEEN
      || !value.seen.every((item) => Array.isArray(item) && item.length === 2 && /^0x[0-9a-f]{64}$/.test(item[0]) && validTime(item[1]))) throw new Error();
    return { ...value, next: pagePosition(value.next) };
  } catch {
    badRequest("Invalid 'since' cursor — use the unmodified cursor for this address");
  }
}

const writeCursor = (value: ActivityCursor) => `w1.${deflateRawSync(JSON.stringify(value)).toString("base64url")}`;

interface Tx {
  hash: string;
  timestamp: string;
  value: string;
  method: string | null;
  from: { hash: string } | null;
  to: { hash: string } | null;
  block_number?: number | null;
  position?: number | null;
}

/** New activity for a Base address since a cursor: transfers in/out, newest first. */
export async function getAddressActivity(address: string, since?: string) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) badRequest("Invalid address — expected 0x + 40 hex chars");
  const addr = address.toLowerCase();
  const state = readCursor(addr, since);
  const query = state.next ? `?${new URLSearchParams(Object.entries(state.next).map(([k, v]) => [k, String(v)]))}` : "";

  // One provider page per call bounds work. A continuation always retains the
  // original lower boundary until every indexed page in that window is read.
  const page = await cached(`activity:base:${addr}:${query}`, 20_000, async () => {
    const res = await blockscoutFetch(`${BLOCKSCOUT}/addresses/${addr}/transactions${query}`, {
      headers: { Accept: "application/json" },
    });
    const json = (await res.json()) as { items?: Tx[]; next_page_params?: unknown };
    if (!Array.isArray(json.items) || json.items.length > PAGE_SIZE) throw new Error("Invalid activity page");
    return { items: json.items, next: pagePosition(json.next_page_params) };
  });

  // Pending transactions have no stable chain position/timestamp. They remain
  // outside this confirmed-transaction feed until Blockscout indexes them.
  const confirmed = page.items.filter((tx) => tx.timestamp != null);
  if (confirmed.some((tx) => !/^0x[0-9a-fA-F]{64}$/.test(tx.hash) || !validTime(Date.parse(tx.timestamp)))) {
    throw new Error("Invalid confirmed transaction in activity source");
  }
  confirmed.sort((a, b) => (b.block_number ?? 0) - (a.block_number ?? 0)
    || (b.position ?? 0) - (a.position ?? 0) || Date.parse(b.timestamp) - Date.parse(a.timestamp)
    || a.hash.localeCompare(b.hash));
  const seen = new Map(state.seen);
  const fresh: Tx[] = [];
  for (const tx of confirmed) {
    const time = Date.parse(tx.timestamp);
    state.watermark = Math.max(state.watermark, time);
    if (time < state.floor || seen.has(tx.hash.toLowerCase())) continue;
    fresh.push(tx);
    seen.set(tx.hash.toLowerCase(), time);
  }
  const crossedFloor = confirmed.some((tx) => Date.parse(tx.timestamp) < state.floor);
  const next = crossedFloor ? null : page.next;
  if (next && state.next && (next.block_number > state.next.block_number
    || (next.block_number === state.next.block_number && next.index >= state.next.index))) {
    throw new Error("Activity pagination did not advance");
  }
  const hasMore = next !== null;
  if (!state.watermark) state.watermark = Date.now();
  if (!hasMore) state.floor = Math.max(state.floor, state.watermark - OVERLAP_MS);
  const ordered = [...seen.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const recent = ordered.filter(([, time]) => time >= state.watermark - OVERLAP_MS);
  state.replayPossible ||= (hasMore ? ordered : recent).length > MAX_SEEN;
  // During backfill, keep both the head and the page boundary, even when the
  // latter is months old. After draining, only the polling overlap is needed.
  state.seen = hasMore
    ? ordered.length <= MAX_SEEN ? ordered : [...ordered.slice(0, PAGE_SIZE), ...ordered.slice(-PAGE_SIZE)]
    : recent.slice(0, MAX_SEEN);
  state.next = next;

  const events = fresh.map((t) => ({
      hash: t.hash,
      at: t.timestamp,
      direction: t.from?.hash?.toLowerCase() === addr ? "out" : "in",
      counterparty:
        (t.from?.hash?.toLowerCase() === addr ? t.to?.hash : t.from?.hash) ?? null,
      ethValue: Number(BigInt(t.value ?? "0")) / 1e18,
      method: t.method,
      blockNumber: t.block_number ?? null,
      transactionIndex: t.position ?? null,
    }));

  return {
    chain: "base",
    address: addr,
    since: since ?? null,
    count: events.length,
    events,
    cursor: writeCursor(state),
    hasMore,
    partial: hasMore,
    coverage: {
      complete: !hasMore,
      scope: "indexed-confirmed-transactions",
      pagesRead: 1,
      overlapSeconds: OVERLAP_MS / 1000,
      deduplicationLimit: MAX_SEEN,
      replayPossible: state.replayPossible,
      note: "Drain hasMore pages before polling again. The last two minutes are rechecked for delayed indexing/reorgs; deduplicate by transaction hash. Indexer gaps and older reorganizations are outside this coverage.",
    },
    at: new Date().toISOString(),
  };
}

/** Pools from the new-token radar that appeared after the given cursor. */
export async function getRadarSince(since?: string) {
  const sinceMs = parseSince(since);
  const radar = await getNewTokenRadar();
  const fresh = radar.pools.filter((p) => Date.parse(p.createdAt) > sinceMs);
  const newest = radar.pools.reduce<string | null>(
    (acc, p) => (!acc || Date.parse(p.createdAt) > Date.parse(acc) ? p.createdAt : acc),
    null,
  );
  return {
    chain: "base",
    since: since ?? null,
    count: fresh.length,
    pools: fresh,
    cursor: newest ?? since ?? new Date().toISOString(),
    partial: true,
    coverage: {
      complete: false,
      scope: "ranked-radar-listing",
      source: radar.source,
      observedAt: radar.at,
      note: "A limited, liquidity-filtered ranked listing, not an exhaustive pool event stream. Pools can be absent or appear after the cursor has advanced.",
    },
    at: new Date().toISOString(),
  };
}

/** Cheap poll: has the price moved past a threshold from the agent's reference? */
export async function getPriceAlert(symbol: string, ref?: string, pct?: string) {
  const reference = Number(ref);
  const threshold = pct === undefined ? 2 : Number(pct);
  if (!Number.isFinite(reference) || reference <= 0) {
    badRequest(
      "Query 'ref' is required — the reference price to compare against, e.g. /api/watch/price/eth?ref=1900&pct=2",
    );
  }
  if (!Number.isFinite(threshold) || threshold < 0) {
    badRequest("Invalid 'pct' — the threshold must be a non-negative number of percent");
  }

  const price = await getPrice(symbol);
  const changePct = ((price.usd - reference) / reference) * 100;
  return {
    symbol: price.symbol,
    usd: price.usd,
    source: price.source,
    quoteCurrency: price.quoteCurrency,
    assumptions: price.assumptions,
    priceObservedAt: price.at,
    ref: reference,
    changePct: Number(changePct.toFixed(4)),
    thresholdPct: threshold,
    triggered: Math.abs(changePct) >= threshold,
    direction: changePct >= 0 ? "up" : "down",
    at: new Date().toISOString(),
  };
}
