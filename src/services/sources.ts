import { fetchWithTimeout } from "./cache.js";

/**
 * Tries each source in order and returns the first that answers. Upstreams are
 * free public APIs — they rate-limit, wobble and occasionally go down — so no
 * endpoint should depend on a single one.
 */
export interface Source<T> {
  name: string;
  load: () => Promise<T>;
}

export async function fromSources<T>(label: string, sources: Source<T>[]): Promise<T> {
  const failures: string[] = [];
  for (const source of sources) {
    try {
      return await source.load();
    } catch (err) {
      failures.push(`${source.name}: ${(err as Error).message}`);
    }
  }
  // Only reached when every source failed; the detail helps us fix it fast.
  console.warn(JSON.stringify({ t: new Date().toISOString(), allSourcesFailed: label, failures }));
  throw new Error(`Upstream data is unavailable for ${label} right now — please retry`);
}

/**
 * GeckoTerminal's free tier allows ~30 requests a minute across all of our
 * serverless instances, so a burst gets 429s. One short retry clears the
 * transient case; sustained limiting still falls through to the next source.
 */
export async function fetchJsonRetrying(
  url: string,
  init: RequestInit = {},
  attempts = 2,
): Promise<unknown> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetchWithTimeout(url, init);
    if (res.ok) return res.json();
    if (res.status !== 429 || attempt >= attempts) throw new Error(`HTTP ${res.status}`);
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }
}

/**
 * Blockscout's public API needs no key, but a key gets its own 10 req/s
 * quota instead of sharing the anonymous pool. Anonymous first (works for
 * everyone, including self-hosters with no key configured), then one retry
 * with the key if we have one — this only helps when the first failure was
 * rate-limiting, not when Blockscout's backend itself is degraded, since a
 * keyed request hits the same indexer.
 */
export async function blockscoutFetch(
  url: string,
  init: RequestInit = {},
  ms = 4000,
): Promise<Response> {
  try {
    const res = await fetchWithTimeout(url, init, ms);
    if (res.ok) return res;
    throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    const key = process.env.BLOCKSCOUT_API_KEY;
    if (!key) throw err;
    const keyed = url + (url.includes("?") ? "&" : "?") + `apikey=${encodeURIComponent(key)}`;
    return fetchWithTimeout(keyed, init, ms);
  }
}

/** Public Base RPCs, tried in order. */
const BASE_RPCS = [
  "https://mainnet.base.org",
  "https://base-rpc.publicnode.com",
  "https://base.meowrpc.com",
];

export async function baseRpc<T>(method: string, params: unknown[] = []): Promise<T> {
  return fromSources<T>(
    `base rpc ${method}`,
    BASE_RPCS.map((url) => ({
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
