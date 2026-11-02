import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { jwtVerify } from 'jose';
import { createCdpFacilitator } from '../src/cdp-facilitator.js';

for (const format of ['ed25519', 'pkcs8', 'sec1', 'escaped-pem'] as const) {
  test(`CDP ${format}: signed, scoped, expiring authentication`, async () => {
    const pair = format === 'ed25519'
      ? generateKeyPairSync('ed25519')
      : generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = pair.privateKey.export({ format: 'jwk' });
    let secret = format === 'ed25519'
      ? Buffer.concat([Buffer.from(jwk.d!, 'base64url'), Buffer.from(jwk.x!, 'base64url')]).toString('base64')
      : pair.privateKey.export({ type: format === 'sec1' ? 'sec1' : 'pkcs8', format: 'pem' }).toString();
    if (format === 'escaped-pem') secret = secret.replace(/\n/g, '\\n');
    const facilitator = createCdpFacilitator({ CDP_API_KEY_ID: 'synthetic-test-id', CDP_API_KEY_SECRET: secret });
    assert.equal(facilitator.url, 'https://api.cdp.coinbase.com/platform/v2/x402');
    const headers = await facilitator.createAuthHeaders();
    const nonces = new Set();
    for (const operation of ['verify', 'settle', 'supported'] as const) {
      const token = headers[operation].Authorization.slice(7);
      const { payload, protectedHeader } = await jwtVerify(token, pair.publicKey, {
        issuer: 'cdp', subject: 'synthetic-test-id', algorithms: [format === 'ed25519' ? 'EdDSA' : 'ES256'],
      });
      assert.deepEqual(payload.uris, [`${operation === 'supported' ? 'GET' : 'POST'} api.cdp.coinbase.com/platform/v2/x402/${operation}`]);
      assert.equal(payload.exp! - payload.iat!, 120);
      assert.equal(payload.nbf, payload.iat);
      assert.equal(protectedHeader.kid, 'synthetic-test-id');
      assert.match(String(protectedHeader.nonce), /^[0-9a-f]{32}$/);
      nonces.add(protectedHeader.nonce);
      await assert.rejects(jwtVerify(token, pair.publicKey, { currentDate: new Date((payload.exp! + 1) * 1000) }));
    }
    assert.equal(nonces.size, 3);
  });
}

test('CDP missing, malformed or wrong-curve credentials fail without disclosure', async () => {
  const wrongCurve = generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  for (const secret of ['', 'not-a-key-sensitive-fixture', Buffer.alloc(32).toString('base64'), wrongCurve]) {
    await assert.rejects(createCdpFacilitator({ CDP_API_KEY_ID: 'test', CDP_API_KEY_SECRET: secret }).createAuthHeaders(),
      (error: Error) => error.message === 'CDP authentication could not be prepared' && error.cause === undefined);
  }
  await assert.rejects(createCdpFacilitator({}).createAuthHeaders(), /CDP authentication could not be prepared/);
});
