import { setTimeout as delay } from 'node:timers/promises';
import { fetchWithTimeout } from './cache.js';
import { requestContext } from '../request-context.js';

export type ActivityProvider = 'blockscout' | 'ankr';

export function activityProvider(env: NodeJS.ProcessEnv = process.env): ActivityProvider {
  const provider = env.ADDRESS_ACTIVITY_PROVIDER ?? 'blockscout';
  if (provider !== 'blockscout' && provider !== 'ankr') throw new Error('ADDRESS_ACTIVITY_PROVIDER must be blockscout or ankr');
  if (provider === 'ankr' && !/^[A-Za-z0-9_-]{16,256}$/.test(env.ANKR_API_KEY?.trim() ?? '')) {
    throw new Error('Ankr address activity requires a valid ANKR_API_KEY');
  }
  return provider;
}

export interface ActivityTx {
  hash: string;
  timestamp: string;
  value: string;
  method: string | null;
  from: { hash: string } | null;
  to: { hash: string } | null;
  block_number?: number | null;
  position?: number | null;
}

export function activityPageToken(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 2048 || !/^[\x21-\x7e]+$/.test(value)) {
    throw new Error('Invalid activity pagination token');
  }
  return value;
}

const invalid = (): never => { throw new Error('Invalid activity provider response'); };
function quantity(value: unknown): bigint {
  if (typeof value !== 'string' || value.length > 80 || !/^(0x[0-9a-fA-F]+|[0-9]+)$/.test(value)) return invalid();
  const n = BigInt(value);
  if (n >= 2n ** 256n) return invalid();
  return n;
}
function safeInteger(value: unknown): number {
  const n = Number(quantity(value));
  if (!Number.isSafeInteger(n)) return invalid();
  return n;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}

function transaction(value: unknown, address: string): ActivityTx {
  const tx = record(value);
  if (tx.blockchain !== 'base' || typeof tx.hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(tx.hash)
    || typeof tx.from !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(tx.from)
    || (tx.to != null && tx.to !== '' && (typeof tx.to !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(tx.to)))) return invalid();
  const to = typeof tx.to === 'string' && tx.to !== '' ? tx.to.toLowerCase() : null;
  if (tx.from.toLowerCase() !== address && to !== address) return invalid();
  const seconds = safeInteger(tx.timestamp);
  if (!Number.isSafeInteger(seconds * 1000) || seconds * 1000 > 8_640_000_000_000_000) return invalid();
  if (tx.status !== undefined && !['0x0', '0x1', '0', '1'].includes(String(tx.status))) return invalid();
  const input = tx.input;
  if (input !== undefined && (typeof input !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(input))) return invalid();
  // Preserve zero-value contract calls and reverted transactions. This is a
  // transaction feed, not a token-transfer API. Undecoded methods use a selector.
  const name = tx.method && typeof tx.method === 'object' ? (tx.method as { name?: unknown }).name : null;
  const method = typeof name === 'string' && /^[A-Za-z_$][A-Za-z0-9_$]{0,79}$/.test(name)
    ? name : typeof input === 'string' && input.length >= 10 ? input.slice(0, 10) : null;
  return { hash: tx.hash.toLowerCase(), timestamp: new Date(seconds * 1000).toISOString(),
    value: quantity(tx.value).toString(), method, from: { hash: tx.from.toLowerCase() }, to: to ? { hash: to } : null,
    block_number: safeInteger(tx.blockNumber), position: safeInteger(tx.transactionIndex) };
}

async function readJson(response: Response): Promise<unknown> {
  if (!response.body) return invalid();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1_048_576) { await reader.cancel(); return invalid(); }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { reader.releaseLock(); }
}

export async function ankrActivityPage(address: string, next: string | null, floor: number, until: number) {
  activityProvider({ ...process.env, ADDRESS_ACTIVITY_PROVIDER: 'ankr' });
  const key = process.env.ANKR_API_KEY!.trim();
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ankr_getTransactionsByAddress', params: {
    address, blockchain: ['base'], descOrder: true, includeLogs: false, pageSize: 50,
    fromTimestamp: Math.floor(floor / 1000), toTimestamp: Math.floor(until / 1000),
    ...(next ? { pageToken: next } : {}),
  } });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // Keep the token on a fixed origin, and never follow redirects with it.
      const res = await fetchWithTimeout(`https://rpc.ankr.com/multichain/${key}`, {
        method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body,
      }, 5000);
      if (!res.ok) {
        const retryAfter = res.headers.get('retry-after');
        await res.body?.cancel();
        const wait = retryAfter === null ? 250 : /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Infinity;
        if (attempt === 0 && [429, 502, 503, 504].includes(res.status) && wait <= 1000) {
          await delay(wait, undefined, { signal: requestContext.getStore()?.signal });
          continue;
        }
        throw new Error(`Activity provider HTTP ${res.status}`);
      }
      const envelope = record(await readJson(res));
      if (envelope.jsonrpc !== '2.0' || envelope.id !== 1 || envelope.error != null) {
        // Error bodies may echo credentials, URLs or user input.
        throw new Error('Activity provider rejected the query');
      }
      const result = record(envelope.result);
      if (!Array.isArray(result.transactions) || result.transactions.length > 50) return invalid();
      if (result.transactions.length === 50 && !Object.hasOwn(result, 'nextPageToken')) return invalid();
      if (result.syncStatus != null && record(result.syncStatus).status !== 'synced') {
        throw new Error('Activity provider is not synchronized');
      }
      const items = result.transactions.map(tx => transaction(tx, address));
      if (items.some(tx => Date.parse(tx.timestamp) > Math.floor(until / 1000) * 1000)) return invalid();
      const token = activityPageToken(result.nextPageToken);
      if (token && (!items.length || token === next)) throw new Error('Activity pagination did not advance');
      return { items, next: token };
    } catch (error) {
      // Do not propagate fetch/parser exceptions: they can include a keyed URL
      // or provider response. Only our bounded, fixed diagnostics leave here.
      const message = error instanceof Error ? error.message : '';
      if (/^(Activity provider HTTP \d{3}|Activity provider rejected the query|Activity provider is not synchronized|Invalid activity provider response|Invalid activity pagination token|Activity pagination did not advance)$/.test(message)) throw new Error(message);
      if (error instanceof Error && error.name === 'TimeoutError') throw new DOMException('Activity provider timed out', 'TimeoutError');
      throw new Error('Activity provider request failed');
    }
  }
  throw new Error('Activity provider request failed');
}
