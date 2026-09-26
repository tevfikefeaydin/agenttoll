import type { BrowserPaymentOutcome, pay } from './demo.js';
import { createPaymentClient, createPaymentDeadline, getNetworkConfig, HOSTED_RECIPIENT, HOSTED_URL } from '../src/payment-policy.js';

export type Network = 'base' | 'base-sepolia';
export type Show = (html: string, tone?: 'quote' | 'ok' | 'err' | 'wait') => void;
export type DeliveredOutcome = Extract<BrowserPaymentOutcome, { status: 'delivered' }>;
export interface QuotedRequest {
  readonly path: string;
  readonly amountUsdc: string;
  readonly quote: unknown;
  readonly recipient: string;
  readonly network: Network;
  readonly at: number;
}
export interface ResearchQuote {
  readonly items: readonly QuotedRequest[];
  readonly totalUsdc: string;
  readonly network: Network;
  readonly recipient: string;
  readonly at: number;
}
export interface BatchResult {
  readonly completed: number;
  readonly results: readonly { readonly request: QuotedRequest; readonly outcome: DeliveredOutcome }[];
  readonly stopReason: 'complete' | 'failed' | 'uncertain' | 'delivery-invalid' | 'stale' | 'invalid' | 'busy' | 'blocked';
  readonly error?: string;
}
export interface ResearchPaymentOptions {
  fetch?: typeof fetch;
  pay?: typeof pay;
  now?: () => number;
}

const CLIENT = 'agenttoll-research/1.0.0';
const MAX_QUOTE_AGE = 60_000;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
export const DISCOVERY_PATH = '/api/base/radar?minLiquidity=10000&limit=15';
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const formatUsdc = (amount: bigint) => `${amount / 1_000_000n}.${(amount % 1_000_000n).toString().padStart(6, '0')}`;
const message = (error: unknown) => (error instanceof Error ? error.message : 'The operation did not complete.').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 300);

function origin(): string {
  const value = window.location.origin;
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value) throw new Error('Invalid API origin.');
  return value;
}

function canonicalPaths(paths: string[]): string[] {
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > 5) throw new Error('Choose one to five unique token inspections, one portfolio lookup, or one discovery request.');
  if (paths.includes(DISCOVERY_PATH)) {
    if (paths.length !== 1) throw new Error('Discovery must be purchased separately from inspections and portfolio lookups.');
    return [DISCOVERY_PATH];
  }
  let portfolio = false;
  const normalized = paths.map(path => {
    const parts = typeof path === 'string' && path.length <= 256
      ? /^\/api\/base\/(safety|portfolio)\/(0x[0-9a-fA-F]{40})(?:\?([^#]+))?$/.exec(path) : null;
    if (!parts || /^0x0{40}$/.test(parts[2])) throw new Error('Invalid research endpoint or address.');
    const [, kind, address, query] = parts;
    if (kind === 'safety' && query !== undefined) throw new Error('Token inspections do not accept query parameters.');
    portfolio ||= kind === 'portfolio';
    const params = new URLSearchParams(query);
    if ((query !== undefined && params.toString() !== query) || [...params.keys()].some(key => !['minValue', 'limit'].includes(key)) ||
        [...params.keys()].some(key => params.getAll(key).length !== 1)) throw new Error('Invalid or duplicate portfolio query parameters.');
    const floor = params.get('minValue');
    const limit = params.get('limit');
    if (floor !== null && (!/^(0|[1-9]\d{0,9})(\.\d{1,6})?$/.test(floor) || Number(floor) > 1_000_000_000 || String(Number(floor)) !== floor)) {
      throw new Error('Portfolio minValue must be a canonical number from 0 to 1000000000.');
    }
    if (limit !== null && !/^(?:[1-9]|[1-4]\d|50)$/.test(limit)) throw new Error('Portfolio limit must be an integer from 1 to 50.');
    const canonical = new URLSearchParams();
    if (floor !== null) canonical.set('minValue', floor);
    if (limit !== null) canonical.set('limit', limit);
    return `/api/base/${kind}/${address.toLowerCase()}${canonical.size ? '?' + canonical : ''}`;
  });
  if (portfolio && normalized.length !== 1) throw new Error('A portfolio lookup must be purchased separately.');
  if (new Set(normalized).size !== normalized.length) throw new Error('Choose unique token addresses; duplicate inspections are not allowed.');
  return normalized;
}

function sameOriginUrl(value: unknown, apiOrigin: string): boolean {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.origin === apiOrigin && url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password;
  } catch { return false; }
}

function identityTerms(value: unknown, apiOrigin: string): { network: Network; recipient: string } {
  const identity = record(value) && record(value.identity) ? value.identity : null;
  const interfaces = record(value) && record(value.interfaces) ? value.interfaces : null;
  const http = interfaces && record(interfaces.http) ? interfaces.http : null;
  const payment = http && record(http.payment) ? http.payment : null;
  if (!record(value) || !sameOriginUrl(value.url, apiOrigin) || !http || !sameOriginUrl(http.baseUrl, apiOrigin) ||
      value.dataNetwork !== 'base' || !payment || payment.protocol !== 'x402' || payment.version !== 2 || payment.asset !== 'USDC') {
    throw new Error('The payment identity does not describe this API origin and Base data service.');
  }
  const recipient = identity?.payTo;
  const network = payment.network === 'eip155:8453' ? 'base' : payment.network === 'eip155:84532' ? 'base-sepolia' : null;
  if (!network || typeof recipient !== 'string' || !ADDRESS.test(recipient) || /^0x0{40}$/.test(recipient)) {
    throw new Error('The payment identity has an invalid network or recipient.');
  }
  if (apiOrigin === HOSTED_URL && recipient.toLowerCase() !== HOSTED_RECIPIENT.toLowerCase()) {
    throw new Error('The payment recipient differs from the hosted AgentToll configuration.');
  }
  getNetworkConfig(network);
  return { network, recipient: recipient.toLowerCase() };
}

function checkResponse(response: Response, url: URL): void {
  if (response.redirected || response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400) ||
      (response.url && response.url !== url.href)) throw new Error('Research requests cannot redirect or change API origin.');
}

async function readIdentity(response: Response, deadline: ReturnType<typeof createPaymentDeadline>): Promise<unknown> {
  if (Number(response.headers.get('content-length')) > 65_536) throw new Error('Oversized payment identity.');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Missing payment identity.');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0;
  let text = '';
  try {
    while (true) {
      const part = await deadline.run(() => reader.read());
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 65_536) throw new Error('Oversized payment identity.');
      text += decoder.decode(part.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function freeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Free previews are pinned to this instance; every attempted batch is single-use. */
export class ResearchPayments {
  readonly #fetch: typeof fetch;
  readonly #pay: typeof pay;
  readonly #now: () => number;
  #paying = false;
  #blocked = false;
  #generation = 0;
  #preview?: AbortController;
  #approved?: { batch: ResearchQuote; origin: string; generation: number };

  constructor(options: ResearchPaymentOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#pay = options.pay ?? (async (path, show, terms) => (await import('./demo.js')).pay(path, show, terms));
    this.#now = options.now ?? Date.now;
  }
  get busy(): boolean { return this.#paying || this.#preview !== undefined; }
  get blocked(): boolean { return this.#blocked; }

  async quote(paths: string[], signal?: AbortSignal): Promise<ResearchQuote> {
    if (this.#paying) throw new Error('A payment is already in progress.');
    const generation = ++this.#generation;
    this.#approved = undefined;
    this.#preview?.abort(new Error('This quote was superseded by a newer request.'));
    const controller = new AbortController();
    this.#preview = controller;
    const onAbort = () => controller.abort(signal?.reason ?? new Error('Quote aborted.'));
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const deadline = createPaymentDeadline(12_000, controller.signal);
    try {
      const requested = canonicalPaths(paths);
      const apiOrigin = origin();
      const at = this.#now();
      const identityUrl = new URL('/.well-known/agent-card.json', apiOrigin);
      const identityResponse = await deadline.run(() => this.#fetch(identityUrl, { signal: deadline.signal, redirect: 'error', cache: 'no-store' }));
      checkResponse(identityResponse, identityUrl);
      if (!identityResponse.ok) throw new Error('The payment identity could not be loaded.');
      const terms = identityTerms(await readIdentity(identityResponse, deadline), apiOrigin);
      const policy = createPaymentClient(terms.network, undefined, { baseUrl: apiOrigin, recipient: terms.recipient, totalBudgetUsdc: '0' });
      let total = 0n;
      const items = await Promise.all(requested.map(async path => {
        const url = new URL(path, apiOrigin);
        const response = await deadline.run(() => this.#fetch(url, {
          signal: deadline.signal, redirect: 'error', cache: 'no-store', headers: { 'X-AgentToll-Client': CLIENT },
        }));
        checkResponse(response, url);
        void response.body?.cancel().catch(() => {});
        if (response.status !== 402) throw new Error(`Expected a payment quote, received HTTP ${response.status}.`);
        const header = response.headers.get('payment-required');
        if (!header || header.length > 32_768) throw new Error('Missing or oversized payment quote.');
        let raw: unknown;
        try { raw = JSON.parse(atob(header)); } catch { throw new Error('Malformed payment quote.'); }
        const checked = policy.validateQuote(raw, url.href);
        if (checked.quote.resource.url !== url.href) throw new Error('The quoted resource does not match the requested query.');
        total += checked.amount;
        return freeze({ path, amountUsdc: formatUsdc(checked.amount), quote: checked.quote, ...terms, at: this.#now() });
      }));
      deadline.check();
      if (generation !== this.#generation) throw new Error('This quote was superseded by a newer request.');
      const batch = freeze({ items, totalUsdc: formatUsdc(total), ...terms, at });
      this.#approved = { batch, origin: apiOrigin, generation };
      return batch;
    } catch (error) {
      controller.abort(error);
      throw error;
    } finally {
      deadline.close();
      signal?.removeEventListener('abort', onAbort);
      if (this.#preview === controller) this.#preview = undefined;
    }
  }

  async run(batch: ResearchQuote, show: Show, onDelivered: (request: QuotedRequest, outcome: DeliveredOutcome) => void): Promise<BatchResult> {
    const results: { request: QuotedRequest; outcome: DeliveredOutcome }[] = [];
    const finish = (stopReason: BatchResult['stopReason'], error?: string): BatchResult => Object.freeze({
      completed: results.length, results: Object.freeze([...results]), stopReason, ...(error ? { error } : {}),
    });
    if (this.busy) return finish('busy', 'A quote or payment is already in progress.');
    const approved = this.#approved;
    this.#approved = undefined;
    if (this.#blocked) return finish('blocked', 'Check your wallet and acknowledge the previous outcome before paying again.');
    if (!approved || batch !== approved.batch || approved.generation !== this.#generation) return finish('invalid', 'Request a new quote before paying.');
    const stale = () => !Number.isFinite(this.#now()) || this.#now() < batch.at || this.#now() - batch.at > MAX_QUOTE_AGE;
    if (stale()) return finish('stale', 'The quote expired. Check the price again before paying.');
    try {
      if (origin() !== approved.origin) throw new Error('The API origin changed. Request a new quote.');
      const policy = createPaymentClient(batch.network, undefined, { baseUrl: approved.origin, recipient: batch.recipient, totalBudgetUsdc: batch.totalUsdc });
      let total = 0n;
      for (const request of batch.items) {
        const checked = policy.validateQuote(request.quote, request.path);
        if (checked.quote.resource.url !== approved.origin + request.path || request.network !== batch.network ||
            request.recipient !== batch.recipient || formatUsdc(checked.amount) !== request.amountUsdc) throw new Error('The displayed payment terms changed.');
        total += checked.amount;
      }
      if (formatUsdc(total) !== batch.totalUsdc) throw new Error('The displayed payment total changed.');
    } catch (error) { return finish('invalid', message(error)); }
    this.#paying = true;
    try {
      for (const request of batch.items) {
        if (stale()) return finish('stale', 'The remaining quotes expired. Check their prices again.');
        let outcome: BrowserPaymentOutcome;
        try {
          outcome = await this.#pay(request.path, show, { quote: request.quote, recipient: request.recipient, client: CLIENT, showRaw: false });
        } catch (error) {
          this.#blocked = true;
          return finish('uncertain', message(error));
        }
        if (!record(outcome) || (outcome.status !== 'failed' && outcome.status !== 'delivered')) {
          this.#blocked = true;
          return finish('uncertain', 'The payment returned an unrecognized outcome. Check your wallet before paying again.');
        }
        if (outcome.status === 'failed') {
          if (outcome.authorizationPossible === false) return finish('failed', 'The request stopped before a payment authorization completed.');
          this.#blocked = true;
          return finish('uncertain', 'A payment authorization may still be valid. Check your wallet and receipt before paying again.');
        }
        if (outcome.network !== request.network || typeof outcome.signed !== 'boolean' ||
            (outcome.transaction !== null && !/^0x[0-9a-fA-F]{64}$/.test(outcome.transaction))) {
          this.#blocked = true;
          return finish('uncertain', 'The delivery has invalid payment metadata. Check your wallet before paying again.');
        }
        // Keep the received payload and receipt even when the consumer cannot parse or save it.
        const retained = Object.freeze({ ...outcome });
        results.push(Object.freeze({ request, outcome: retained }));
        try { await onDelivered(request, { ...retained, data: structuredClone(retained.data) }); }
        catch (error) {
          this.#blocked = true;
          return finish('delivery-invalid', message(error));
        }
      }
      return finish('complete');
    } finally { this.#paying = false; }
  }

  acknowledgeUncertain(): void {
    if (this.#paying || !this.#blocked) return;
    this.#blocked = false;
    this.#approved = undefined;
    this.#generation++;
    this.#preview?.abort(new Error('The previous quote was invalidated by acknowledgement. Request a new quote.'));
  }
}
