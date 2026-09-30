import test from 'node:test';
import assert from 'node:assert/strict';
import { readConfig } from '../src/config.js';

const valid = { ADDRESS: '0x1111111111111111111111111111111111111111' };
test('configuration rejects a missing or invalid receiving address', () => {
  assert.throws(() => readConfig({}), /ADDRESS/);
  assert.throws(() => readConfig({ ADDRESS: '0xYourBaseAddress' }), /ADDRESS/);
  assert.throws(() => readConfig({ ADDRESS: '0x' + '0'.repeat(40) }), /ADDRESS/);
});
test('configuration rejects unknown networks and unsafe URLs', () => {
  assert.throws(() => readConfig({ ...valid, NETWORK: 'bsae' }), /NETWORK/);
  assert.throws(() => readConfig({ ...valid, PUBLIC_URL: 'https://user:password@example.com' }), /PUBLIC_URL/);
  assert.throws(() => readConfig({ ...valid, FACILITATOR_URL: 'http://remote.example' }), /FACILITATOR_URL/);
});
test('local proxy trust is disabled and payment/data networks are separate', () => {
  const cfg = readConfig(valid);
  assert.equal(cfg.trustProxy, false);
  assert.equal(cfg.network, 'base-sepolia');
  assert.equal(cfg.dataNetwork, 'base');
  assert.equal(cfg.chain, 'eip155:84532');
  assert.equal(readConfig({ ...valid, VERCEL: '1' }).trustProxy, 1);
});
test('mainnet CDP configuration fails early when credentials are missing', () => {
  assert.throws(() => readConfig({ ...valid, NETWORK: 'base' }), /CDP_API_KEY/);
  assert.throws(() => readConfig({ ...valid, NETWORK: 'base', FACILITATOR_URL: 'https://x402.org/facilitator/' }), /CDP_API_KEY/);
  assert.equal(readConfig({ ...valid, NETWORK: 'base', FACILITATOR_URL: 'https://facilitator.example' }).useCdp, false);
});
