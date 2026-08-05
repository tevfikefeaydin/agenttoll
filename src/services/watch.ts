import { cached, fetchWithTimeout } from "./cache.js";
import { getPrice } from "./prices.js";
import { getNewTokenRadar } from "./radar.js";

// Stateless "what changed since I last asked" endpoints. The agent keeps the
// cursor, so the server stores nothing and every reply is verifiable.
const MAINNET = (process.env.NETWORK ?? "base-sepolia") === "base";
const BLOCKSCOUT = MAINNET
  ? "https://base.blockscout.com/api/v2"
  : "https://base-sepolia.blockscout.com/api/v2";

function parseSince(since?: string): number {
  if (!since) return 0;
  const t = Date.parse(since);
  if (Number.isNaN(t)) throw new Error("Invalid 'since' — use an ISO timestamp");
  return t;
}

interface Tx {
  hash: string;
  timestamp: string;
  value: string;
  method: string | null;
  from: { hash: string } | null;
  to: { hash: string } | null;
}

/** New activity for a Base address since a cursor: transfers in/out, newest first. */
export async function getAddressActivity(address: string, since?: string) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error("Invalid address");
  const addr = address.toLowerCase();
  const sinceMs = parseSince(since);

  const all = await cached(`activity:${addr}`, 20_000, async () => {
    const res = await fetchWithTimeout(
      `${BLOCKSCOUT}/addresses/${addr}/transactions`,
      { headers: { Accept: "application/json" } },
    );
    if (!res.ok) throw new Error(`Indexer returned ${res.status}`);
    return ((await res.json()) as { items?: Tx[] }).items ?? [];
  });

  const events = all
    .filter((t) => Date.parse(t.timestamp) > sinceMs)
    .slice(0, 50)
    .map((t) => ({
      hash: t.hash,
      at: t.timestamp,
      direction: t.from?.hash?.toLowerCase() === addr ? "out" : "in",
      counterparty:
        (t.from?.hash?.toLowerCase() === addr ? t.to?.hash : t.from?.hash) ?? null,
      ethValue: Number(BigInt(t.value ?? "0")) / 1e18,
      method: t.method,
    }));

  return {
    chain: "base",
    address: addr,
    since: since ?? null,
    count: events.length,
    events,
    // Pass this back as ?since on the next call to get only newer activity.
    cursor: all[0]?.timestamp ?? since ?? new Date().toISOString(),
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
    at: new Date().toISOString(),
  };
}

/** Cheap poll: has the price moved past a threshold from the agent's reference? */
export async function getPriceAlert(symbol: string, ref?: string, pct?: string) {
  const reference = Number(ref);
  const threshold = pct === undefined ? 2 : Number(pct);
  if (!Number.isFinite(reference) || reference <= 0) {
    throw new Error("Query 'ref' is required: the reference price to compare against");
  }
  if (!Number.isFinite(threshold) || threshold < 0) throw new Error("Invalid 'pct'");

  const price = await getPrice(symbol);
  const changePct = ((price.usd - reference) / reference) * 100;
  return {
    symbol: price.symbol,
    usd: price.usd,
    ref: reference,
    changePct: Number(changePct.toFixed(4)),
    thresholdPct: threshold,
    triggered: Math.abs(changePct) >= threshold,
    direction: changePct >= 0 ? "up" : "down",
    at: new Date().toISOString(),
  };
}
