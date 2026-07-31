// Tiny in-memory TTL cache. Serverless instances each keep their own copy,
// which is fine: the goal is protecting upstream rate limits, not consistency.
const store = new Map<string, { value: unknown; expires: number }>();
const MAX_ENTRIES = 300; // user-influenced keys (token/address) must not grow unbounded

export async function cached<T>(
  key: string,
  ttlMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  const hit = store.get(key);
  if (hit && hit.expires > Date.now()) return hit.value as T;
  const value = await fn();
  if (store.size >= MAX_ENTRIES) {
    for (const k of Array.from(store.keys()).slice(0, MAX_ENTRIES / 3)) store.delete(k);
  }
  store.set(key, { value, expires: Date.now() + ttlMs });
  return value;
}

// Shared fetch with a hard upstream timeout so a hung source can't stall us.
export function fetchWithTimeout(url: string, init: RequestInit = {}, ms = 8000) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
}
