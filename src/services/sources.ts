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

/** Public Base RPCs, tried in order. */
const BASE_RPCS = [
  "https://mainnet.base.org",
  "https://base-rpc.publicnode.com",
  "https://base.llamarpc.com",
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
