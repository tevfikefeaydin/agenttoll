import { requestContext, withSignal } from '../request-context.js';

// Tiny in-memory TTL cache. Serverless instances each keep their own copy,
// which is fine: the goal is protecting upstream rate limits, not consistency.
const store = new Map<string, { value: unknown; expires: number }>();
const MAX_ENTRIES = 300; // user-influenced keys (token/address) must not grow unbounded
const pending = new Map<string, { promise: Promise<unknown>; signal?: AbortSignal }>();

export async function cached<T>(
  key: string,
  ttlMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  const hit = store.get(key);
  const context = requestContext.getStore();
  context?.signal.throwIfAborted();
  if (hit && hit.expires > Date.now()) {
    if (context) context.cacheHits++;
    return hit.value as T;
  }
  const loading = pending.get(key);
  if (loading) {
    if (context) context.coalescedLoads++;
    try {
      return await (context ? withSignal(loading.promise as Promise<T>, context.signal) : loading.promise as Promise<T>);
    } catch (error) {
      context?.signal.throwIfAborted();
      // The original reader owns its upstream request. If it disconnects,
      // independent readers retry with their own still-live request context.
      if (loading.signal?.aborted) return cached(key, ttlMs, fn);
      throw error;
    }
  }
  if (context) context.cacheMisses++;
  if (pending.size >= MAX_ENTRIES) throw new Error('Too many upstream loads in progress — please retry');
  const operation = Promise.resolve().then(fn);
  const promise = (context ? withSignal(operation, context.signal) : operation).then((value) => {
    context?.signal.throwIfAborted();
    if (store.size >= MAX_ENTRIES) {
      for (const k of Array.from(store.keys()).slice(0, MAX_ENTRIES / 3)) store.delete(k);
    }
    store.set(key, { value, expires: Date.now() + ttlMs });
    return value;
  }).finally(() => { pending.delete(key); });
  pending.set(key, { promise, signal: context?.signal });
  return promise;
}

// Shared fetch with a hard upstream timeout so a hung source can't stall us.
export async function fetchWithTimeout(url: string, init: RequestInit = {}, ms = 8000) {
  const context = requestContext.getStore();
  const signals = [AbortSignal.timeout(ms), init.signal, context?.signal].filter((signal): signal is AbortSignal => Boolean(signal));
  const signal = AbortSignal.any(signals);
  signal.throwIfAborted();
  if (context) context.upstreamCalls++;
  return fetch(url, { ...init, signal });
}
