// Read-only HTTPS checks. An optional IP overrides routing, never TLS verification.
// Usage: node deploy/hetzner/verify-proxy.mjs [167.233.31.87] [report.json]
import https from 'node:https';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { ENDPOINTS } from '../../dist/endpoints.js';

const targetIp = process.argv[2] || undefined;
const reportFile = process.argv[3];
const root = new URL('../../', import.meta.url);
const expectedHeaders = Object.fromEntries(JSON.parse(readFileSync(new URL('vercel.json', root)))
  .headers[0].headers.map(({ key, value }) => [key.toLowerCase(), value]));
const checks = [];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function request(path, { host = 'agenttoll.app', method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: targetIp ?? host, servername: host, port: 443,
      path, method, headers: { Host: host, 'User-Agent': 'AgentToll-Migration-ReadOnly/1', ...headers },
      rejectUnauthorized: true, signal: AbortSignal.timeout(15000),
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function check(name, action) {
  const start = Date.now();
  try { const result = await action(); checks.push({ name, ok: true, ms: Date.now() - start, ...result }); }
  catch (error) { checks.push({ name, ok: false, ms: Date.now() - start, error: String(error.message) }); }
}
function assert(condition, message) { if (!condition) throw new Error(message); }
function security(response) {
  for (const [name, value] of Object.entries(expectedHeaders)) {
    assert(response.headers[name] === value, `Header mismatch: ${name}`);
  }
}

for (const [path, file] of Object.entries({
  '/': 'index.html', '/run': 'run.html', '/terms': 'terms.html',
  '/legal': 'terms.html', '/legal-notice': 'terms.html', '/imprint': 'terms.html',
  '/privacy': 'privacy.html', '/privacy-policy': 'privacy.html',
  '/favicon.ico': 'icon.png', '/app.js': 'app.js', '/demo.js': 'demo.js',
  '/run.js': 'run.js', '/openapi.json': 'openapi.json', '/llms.txt': 'llms.txt',
  '/robots.txt': 'robots.txt', '/sitemap.xml': 'sitemap.xml',
  '/icon.png': 'icon.png', '/hero-poster.jpg': 'hero-poster.jpg', '/og.png': 'og.png',
})) {
  await check(path, async () => {
    const response = await request(path);
    assert(response.status === 200, `HTTP ${response.status}`);
    security(response);
    const sha256 = digest(response.body);
    const local = readFileSync(new URL(`public/${file}`, root));
    const bytesMatch = sha256 === digest(local);
    const normalize = bytes => bytes.toString('utf8').replace(/\r\n/g, '\n');
    assert(bytesMatch || (!/\.(png|jpg|webp)$/.test(file) && normalize(response.body) === normalize(local)), 'Content differs from release');
    return { status: response.status, sha256, bytesMatch, contentMatches: true };
  });
}

await check('Video range request', async () => {
  const local = readFileSync(new URL('public/hero.mp4', root));
  const response = await request('/hero.mp4', { headers: { Range: 'bytes=0-1023' } });
  assert(response.status === 206, `HTTP ${response.status}`);
  security(response);
  assert(response.headers['content-range'] === `bytes 0-1023/${local.length}`, 'Wrong media range');
  assert(response.body.equals(local.subarray(0, 1024)), 'Media bytes differ from release');
  return { status: response.status, totalBytes: local.length };
});

for (const path of ['/.well-known/x402', '/.well-known/agent-card.json']) {
  await check(path, async () => {
    const response = await request(path);
    assert(response.status === 200, `HTTP ${response.status}`);
    security(response);
    const value = JSON.parse(response.body);
    assert((value.payTo ?? value.identity?.payTo)?.toLowerCase() === '0xe55359021a6a22d8385b827405991c56075f56f8', 'Wrong receiver');
    assert((value.openapi ?? value.interfaces?.http?.openapi) === 'https://agenttoll.app/openapi.json', 'Wrong canonical URL');
    assert(value.dataNetwork === 'base', 'Wrong data network');
    if (path === '/.well-known/x402') {
      assert(value.network === 'base' && value.x402Version === 2, 'Wrong discovery payment network');
      assert(value.resources?.length === ENDPOINTS.length && ENDPOINTS.every(endpoint =>
        value.resources.some(resource => resource.resource === `https://agenttoll.app${endpoint.path}` && resource.price === endpoint.price)),
      'Wrong discovery resources');
    } else {
      assert(value.url === 'https://agenttoll.app' && value.interfaces?.http?.baseUrl === 'https://agenttoll.app', 'Wrong agent-card origin');
      assert(value.interfaces.http.payment.network === 'eip155:8453' && value.interfaces.http.payment.asset === 'USDC', 'Wrong agent-card payment identity');
      assert(value.interfaces.http.discovery === 'https://agenttoll.app/.well-known/x402', 'Wrong discovery URL');
      assert(ENDPOINTS.every(endpoint => value.skills?.some(skill => skill.id === endpoint.path &&
        skill.url === `https://agenttoll.app${endpoint.path}` && skill.price === endpoint.price)), 'Wrong agent-card resources');
    }
    return { status: response.status };
  });
}

await check('www redirect retains path and query', async () => {
  const response = await request('/run?migration=1', { host: 'www.agenttoll.app' });
  assert([301, 307, 308].includes(response.status), `HTTP ${response.status}`);
  assert(response.headers.location === 'https://agenttoll.app/run?migration=1', 'Wrong redirect');
  return { status: response.status, location: response.headers.location };
});

await check('CORS preflight', async () => {
  const response = await request('/api/gas', { method: 'OPTIONS', headers: {
    Origin: 'https://client.example', 'Access-Control-Request-Method': 'GET',
    'Access-Control-Request-Headers': 'payment-signature, x-payment',
  } });
  assert(response.status === 204, `HTTP ${response.status}`);
  security(response);
  assert(response.headers['access-control-allow-origin'] === '*', 'Wrong CORS origin');
  for (const name of ['PAYMENT-SIGNATURE', 'X-PAYMENT']) {
    assert(response.headers['access-control-allow-headers']?.includes(name), `${name} not allowed`);
  }
  for (const method of ['GET', 'HEAD', 'OPTIONS']) {
    assert(response.headers['access-control-allow-methods']?.includes(method), `${method} not allowed`);
  }
  return { status: response.status };
});

await check('Unsigned payment challenge over HTTPS', async () => {
  const response = await request('/api/gas');
  assert(response.status === 402, `HTTP ${response.status}`);
  security(response);
  const challenge = JSON.parse(Buffer.from(response.headers['payment-required'] ?? '', 'base64').toString());
  assert(challenge.resource?.url === 'https://agenttoll.app/api/gas', 'Wrong HTTPS resource');
  assert(challenge.accepts?.length > 0 && challenge.accepts.every(value => value.network === 'eip155:8453' &&
    value.payTo?.toLowerCase() === '0xe55359021a6a22d8385b827405991c56075f56f8' &&
    value.asset?.toLowerCase() === '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'), 'Wrong payment identity');
  assert(Number(response.headers.age ?? 0) === 0, 'Unexpected cached challenge');
  assert(!/\b(public|s-maxage)\b/i.test(response.headers['cache-control'] ?? ''), 'Shared caching enabled');
  for (const name of ['PAYMENT-REQUIRED', 'PAYMENT-RESPONSE', 'X-PAYMENT-RESPONSE']) {
    assert(response.headers['access-control-expose-headers']?.includes(name), `${name} not exposed`);
  }
  return { status: response.status, resourceUrl: challenge.resource.url };
});

const report = { ok: checks.every(value => value.ok), checkedAt: new Date().toISOString(),
  origin: 'https://agenttoll.app', targetIp: targetIp ?? 'public DNS',
  scope: 'TLS verified; static content (CRLF normalized), security headers, discovery, redirects, CORS and unsigned payment challenge', checks };
if (reportFile) writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.ok ? 0 : 1;
