import { isIP } from 'node:net';

export type PaymentNetwork = 'base' | 'base-sepolia';

function urlSetting(name: string, value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${name} must be an absolute HTTP(S) URL`); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} must use HTTPS (HTTP is allowed for localhost) without credentials, query or fragment`);
  }
  return url.toString().replace(/\/$/, '');
}

function integer(name: string, value: string | undefined, fallback: number, min: number, max: number) {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return n;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const payTo = env.ADDRESS?.trim();
  if (!payTo || !/^0x[0-9a-fA-F]{40}$/.test(payTo) || /^0x0{40}$/i.test(payTo)) {
    throw new Error('ADDRESS must be your nonzero receiving wallet address (0x + 40 hex characters)');
  }
  const network = env.NETWORK ?? 'base-sepolia';
  if (network !== 'base' && network !== 'base-sepolia') throw new Error('NETWORK must be base or base-sepolia');
  const port = integer('PORT', env.PORT, 4021, 1, 65535);
  const requestTimeoutMs = integer('REQUEST_TIMEOUT_MS', env.REQUEST_TIMEOUT_MS, 25_000, 100, 120_000);
  const facilitatorUrl = urlSetting('FACILITATOR_URL', env.FACILITATOR_URL ?? 'https://x402.org/facilitator');
  const useCdp = network === 'base' && facilitatorUrl === 'https://x402.org/facilitator';
  if (useCdp && (!env.CDP_API_KEY_ID?.trim() || !env.CDP_API_KEY_SECRET?.trim())) {
    throw new Error('Mainnet CDP settlement requires CDP_API_KEY_ID and CDP_API_KEY_SECRET');
  }
  const host = env.VERCEL_PROJECT_PRODUCTION_URL ?? env.VERCEL_URL;
  const publicUrl = urlSetting('PUBLIC_URL', env.PUBLIC_URL ?? (env.VERCEL === '1' && host ? `https://${host}` : `http://localhost:${port}`));
  let trustProxy: false | number | string[] = env.VERCEL === '1' ? 1 : false;
  if (env.TRUST_PROXY !== undefined) {
    const raw = env.TRUST_PROXY.trim();
    if (raw === 'false' || raw === '0') trustProxy = false;
    else if (/^[1-5]$/.test(raw)) trustProxy = Number(raw);
    else {
      const entries = raw.split(',').map((entry) => entry.trim());
      if (!entries.length || entries.some((entry) => {
        if (['loopback', 'linklocal', 'uniquelocal'].includes(entry)) return false;
        const [address, prefix, extra] = entry.split('/');
        const family = isIP(address);
        return !family || extra !== undefined || (prefix !== undefined && (!/^\d+$/.test(prefix) || Number(prefix) > (family === 4 ? 32 : 128)));
      })) throw new Error('TRUST_PROXY must be false, 1–5 trusted hops, or explicit IP/CIDR entries');
      trustProxy = entries;
    }
  }
  return { payTo: payTo as `0x${string}`, network: network as PaymentNetwork, dataNetwork: 'base' as const,
    chain: network === 'base' ? 'eip155:8453' as const : 'eip155:84532' as const,
    port, publicUrl, facilitatorUrl, useCdp, trustProxy, requestTimeoutMs };
}
