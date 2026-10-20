import test from 'node:test';
import assert from 'node:assert/strict';
import { ENDPOINTS } from '../src/endpoints.js';
import { activeCatalogueEndpoints } from '../src/endpoint-availability.js';

test('discovery availability requires a complete catalogue with canonical prices and explicit boolean pauses', () => {
  const entries = ENDPOINTS.map(endpoint => ({ path: endpoint.path, price: endpoint.price, available: true }));
  const catalogue = (endpoints: unknown) => ({ network: 'base', endpoints });
  assert.equal(activeCatalogueEndpoints(catalogue(entries)).length, ENDPOINTS.length);
  const paused = entries.map((entry, index) => ({ ...entry, available: index !== 0 }));
  assert.ok(!activeCatalogueEndpoints(catalogue(paused)).includes(ENDPOINTS[0]));
  assert.equal(activeCatalogueEndpoints(catalogue(entries.map(({ path, price }) => ({ path, price })))).length, ENDPOINTS.length);
  for (const invalid of [null, {}, { network: 'base', endpoints: null }, catalogue(entries.slice(1)),
    catalogue([...entries, entries[0]]), catalogue(entries.map((entry, index) => index === 0 ? { ...entry, price: '$0' } : entry)),
    catalogue(entries.map((entry, index) => index === 0 ? { ...entry, available: 'false' } : entry))]) {
    assert.throws(() => activeCatalogueEndpoints(invalid), /Invalid availability catalogue/);
  }
});
