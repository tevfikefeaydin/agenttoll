// Tiny in-memory TTL cache. Serverless instances each keep their own copy,
// which is fine: the goal is protecting upstream rate limits, not consistency.
const store = new Map<string, { value: unknown; expires: number }>();

export async function cached<T>(
  key: string,
  ttlMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  const hit = store.get(key);
  if (hit && hit.expires > Date.now()) return hit.value as T;
  const value = await fn();
  store.set(key, { value, expires: Date.now() + ttlMs });
  return value;
}
