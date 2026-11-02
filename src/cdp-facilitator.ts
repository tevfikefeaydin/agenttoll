import { createPrivateKey, randomBytes } from 'node:crypto';
import { importJWK, importPKCS8, SignJWT } from 'jose';

// CDP REST authentication: https://docs.cdp.coinbase.com/get-started/authentication/jwt-authentication
// Keep signing scoped to the three fixed facilitator operations. No wallet signing,
// configurable destination, logging, token persistence or full custody SDK is needed.
const host = 'api.cdp.coinbase.com';
const prefix = '/platform/v2/x402';

export function createCdpFacilitator(env: NodeJS.ProcessEnv = process.env) {
  return {
    url: `https://${host}${prefix}`,
    async createAuthHeaders() {
      try {
        const id = env.CDP_API_KEY_ID?.trim();
        const secret = env.CDP_API_KEY_SECRET?.trim();
        if (!id || !secret) throw new Error();
        let alg: 'ES256' | 'EdDSA';
        let key: Awaited<ReturnType<typeof importPKCS8>>;
        if (secret.startsWith('-----BEGIN')) {
          const parsed = createPrivateKey(secret.replace(/\\n/g, '\n'));
          if (parsed.asymmetricKeyType !== 'ec' || parsed.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error();
          alg = 'ES256';
          key = await importPKCS8(parsed.export({ type: 'pkcs8', format: 'pem' }).toString(), alg);
        } else {
          const bytes = Buffer.from(secret, 'base64');
          if (bytes.length !== 64 || bytes.toString('base64') !== secret) throw new Error();
          alg = 'EdDSA';
          key = await importJWK({ kty: 'OKP', crv: 'Ed25519',
            d: bytes.subarray(0, 32).toString('base64url'), x: bytes.subarray(32).toString('base64url') }, alg) as typeof key;
        }
        const now = Math.floor(Date.now() / 1000);
        const sign = async (method: string, operation: string) => ({ Authorization: `Bearer ${await new SignJWT({
          sub: id, iss: 'cdp', uris: [`${method} ${host}${prefix}/${operation}`],
        }).setProtectedHeader({ alg, typ: 'JWT', kid: id, nonce: randomBytes(16).toString('hex') })
          .setIssuedAt(now).setNotBefore(now).setExpirationTime(now + 120).sign(key)}` });
        const [verify, settle, supported] = await Promise.all([
          sign('POST', 'verify'), sign('POST', 'settle'), sign('GET', 'supported'),
        ]);
        return { verify, settle, supported };
      } catch {
        // Crypto errors can include input; never expose credentials or signing details.
        throw new Error('CDP authentication could not be prepared');
      }
    },
  };
}
export const facilitator = createCdpFacilitator();
