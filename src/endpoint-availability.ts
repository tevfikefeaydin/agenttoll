import { ENDPOINTS } from './endpoints.js';

/** A missing or malformed catalogue must never excuse missing discovery entries. */
export function activeCatalogueEndpoints(value: unknown) {
  const catalogue = value as { network?: unknown; endpoints?: Record<string, unknown>[] } | null;
  if (catalogue?.network !== 'base' || !Array.isArray(catalogue.endpoints)) throw new Error('Invalid availability catalogue');
  return ENDPOINTS.filter(endpoint => {
    const entries = catalogue.endpoints!.filter(entry => entry?.path === endpoint.path);
    if (entries.length !== 1 || entries[0].price !== endpoint.price ||
      (entries[0].available !== undefined && typeof entries[0].available !== 'boolean')) throw new Error('Invalid availability catalogue');
    return entries[0].available !== false;
  });
}
