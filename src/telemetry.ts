import { ENDPOINT_MANIFEST } from './endpoint-manifest.js';

const paidRoutes = ENDPOINT_MANIFEST.map(endpoint => ({
  path: endpoint.path,
  pattern: new RegExp('^' + endpoint.path.replace(/\{[^}]+\}/g, '[^/]+') + '$', 'i'),
}));
const publicRoutes = new Set(['/api/health', '/api/ready', '/api/stats', '/api/catalog', '/api/demo',
  '/.well-known/x402', '/.well-known/agent-card.json']);

/** Bounded-cardinality route labels: never emit wallet, name or query values. */
export function canonicalRoute(pathname: string): string {
  const path = pathname.split('?')[0].toLowerCase().replace(/\/+$/, '') || '/';
  if (publicRoutes.has(path)) return path;
  return paidRoutes.find(route => route.pattern.test(path))?.path ??
    (path.startsWith('/.well-known/') ? '/.well-known/unknown' : '/api/unknown');
}

/**
 * @x402/core 2.21.0's HTTP client prints EXTENSION-RESPONSES before returning.
 * Its field-name filter leaves arbitrary extension keys and reason/code values,
 * including nested payloads. There is no SDK logger/transport injection option.
 * Suppress only this exact diagnostic in our payment request context, including
 * late completions after cancellation. All other logs and contexts pass through.
 * Recheck this adapter when upgrading the SDK; never broaden it to all SDK logs.
 */
export function installPaymentDiagnosticFilter(inPaymentContext: () => boolean): () => void {
  const original = console.log;
  const filtered: typeof console.log = (...args) => {
    if (inPaymentContext() && typeof args[0] === 'string' && args[0].startsWith('[x402] extension responses: ')) return;
    original.apply(console, args);
  };
  console.log = filtered;
  return () => { if (console.log === filtered) console.log = original; };
}
