import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  requestId: string;
  signal: AbortSignal;
  upstreamCalls: number;
  cacheHits: number;
  cacheMisses: number;
  coalescedLoads: number;
  facilitatorFailure?: unknown;
  settlementStarted?: boolean;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

/** Stop waiting for an upstream even when its client ignores cancellation. */
export async function withSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  // Observe an already-started operation even if cancellation won the race.
  if (signal.aborted) {
    void operation.catch(() => {});
    throw signal.reason;
  }
  let onAbort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try { return await Promise.race([operation, cancelled]); }
  finally { signal.removeEventListener('abort', onAbort); }
}
