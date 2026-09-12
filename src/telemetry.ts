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
