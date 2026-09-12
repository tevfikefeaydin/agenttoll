import { ENDPOINTS } from './endpoints.js';
import { createPaymentClient } from './payment-policy.js';
import { withSignal } from './request-context.js';

/** No key loading and no signer: this check cannot authorize a payment. */
export async function checkService(options: { baseUrl?: string; network?: string; recipient?: string; timeoutMs?: number; signal?: AbortSignal } = {}) {
  const network = options.network ?? 'base';
  const timeoutMs = options.timeoutMs ?? 5_000;
  const client = createPaymentClient(network, undefined, { ...options, totalBudgetUsdc: '0', timeoutMs });
  const budget = client.getPaymentBudget();
  const signal = AbortSignal.any([AbortSignal.timeout(60_000), ...(options.signal ? [options.signal] : [])]);
  const checks: { path: string; ok: boolean; status: number | null; ms: number; error?: string }[] = [];
  for (const path of ['/api/health', '/api/ready', '/api/catalog']) {
    const started = Date.now();
    let status: number | null = null;
    try {
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
      const response = await withSignal(fetch(new URL(path, budget.apiOrigin), {
        method: 'GET', redirect: 'manual', signal: deadline, headers: { 'User-Agent': 'AgentToll-ReadOnly-Monitor/1' },
      }), deadline);
      status = response.status;
      if (!response.ok) { await response.body?.cancel(); throw new Error(); }
      const body = await withSignal(response.json(), deadline);
      const valid = path === '/api/catalog'
        ? body.network === network && Array.isArray(body.endpoints) && ENDPOINTS.every(endpoint =>
          body.endpoints.some((entry: { path?: string; price?: string }) => entry.path === endpoint.path && entry.price === endpoint.price))
        : body.ok === true && body.network === network && body.dataNetwork === 'base' &&
          (path !== '/api/ready' || (body.checks?.facilitator === true && body.checks?.baseRpc === true));
      if (!valid) throw new Error();
      checks.push({ path, ok: true, status, ms: Date.now() - started });
    } catch {
      checks.push({ path, ok: false, status, ms: Date.now() - started, error: signal.aborted ? 'CHECK_DEADLINE' : 'INVALID_OR_UNAVAILABLE_RESPONSE' });
    }
  }
  for (const endpoint of ENDPOINTS) {
    const started = Date.now();
    const path = endpoint.path.replace(/\{(\w+)\}/g, (_, name) => {
      const params = endpoint.discovery.pathParams as Record<string, string> | undefined;
      return encodeURIComponent(params?.[name] ?? '');
    });
    try {
      await client.getPaymentQuote(path, { signal, headers: { 'User-Agent': 'AgentToll-ReadOnly-Monitor/1' } });
      checks.push({ path: endpoint.path, ok: true, status: 402, ms: Date.now() - started });
    } catch {
      checks.push({ path: endpoint.path, ok: false, status: null, ms: Date.now() - started,
        error: signal.aborted ? 'CHECK_DEADLINE' : 'INVALID_OR_UNAVAILABLE_QUOTE' });
    }
  }
  return { ok: checks.every(check => check.ok), checkedAt: new Date().toISOString(), origin: budget.apiOrigin,
    scope: 'Liveness, readiness, catalog and unsigned quotes only; paid data and settlement are not exercised.',
    checks, budget };
}
