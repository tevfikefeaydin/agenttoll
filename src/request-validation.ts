import type { Discovery } from './discovery.js';
import { badRequest } from './services/errors.js';
import { optionalBoolean, optionalEnum, optionalInt, optionalNumber, optionalSymbolList, validateSnapshotDate } from './services/params.js';
import { normalize as normalizeBasename } from './services/basename.js';
import { parsePriceAlert, parseSince, validateActivityCursor } from './services/watch.js';

type Schema = { type?: string; pattern?: string; minimum?: number; maximum?: number; enum?: string[] };

/** Pure preflight: no facilitator initialization, provider requests or payment authorization. */
export function validateEndpointInput(endpoint: { path: string; discovery: Discovery }, params: Record<string, unknown>, query: Record<string, unknown>): void {
  const properties = endpoint.discovery.inputSchema?.properties ?? {};
  const values: Record<string, string | undefined> = {};
  for (const [key, raw] of Object.entries(query)) {
    if (!Object.hasOwn(properties, key)) badRequest('Unknown query parameter');
    if (typeof raw !== 'string') badRequest(`Query '${key}' must have exactly one string value`);
    values[key] = raw;
  }
  for (const key of endpoint.discovery.inputSchema?.required ?? []) {
    if (!values[key]?.trim()) badRequest(`Query '${key}' is required`);
  }
  for (const [key, property] of Object.entries(properties)) {
    const schema = property as Schema;
    const raw = values[key];
    const range = { min: schema.minimum ?? -Number.MAX_VALUE, max: schema.maximum ?? Number.MAX_VALUE };
    // These service limits also apply when the discovery description omits a maximum.
    if (key === 'minLiquidity' || key === 'minValue') range.max = 1_000_000_000;
    if (schema.type === 'integer') optionalInt(key, raw, range);
    else if (schema.type === 'number') optionalNumber(key, raw, range);
    else if (schema.type === 'boolean') optionalBoolean(key, raw);
    if (schema.enum) optionalEnum(key, raw, schema.enum);
  }
  for (const [key, property] of Object.entries(endpoint.discovery.pathParamsSchema?.properties ?? {})) {
    const value = params[key];
    if (typeof value !== 'string') badRequest('Missing path parameter');
    const pattern = (property as Schema).pattern;
    if (pattern && !new RegExp(pattern).test(value)) badRequest(`Invalid '${key}' path parameter`);
    if (key === 'symbol' && !/^[a-z0-9][a-z0-9-]{0,127}$/i.test(value)) badRequest('Invalid ticker or CoinGecko id');
    if (key === 'nameOrAddress') normalizeBasename(value);
  }
  if (Object.hasOwn(properties, 'symbols')) optionalSymbolList('symbols', values.symbols, 6);
  if (Object.hasOwn(properties, 'date')) validateSnapshotDate(values.date);
  if (endpoint.path === '/api/watch/address/{address}') validateActivityCursor(String(params.address), values.since);
  if (endpoint.path === '/api/watch/radar') parseSince(values.since);
  if (endpoint.path === '/api/watch/price/{symbol}') parsePriceAlert(values.ref, values.pct);
}
