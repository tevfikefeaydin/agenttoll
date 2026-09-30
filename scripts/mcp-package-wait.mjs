// Read-only npm propagation gate. Never retries publishing or other writes.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PACKAGE = 'agenttoll-mcp';
const integrityPattern = /^sha512-[A-Za-z0-9+/]{86}==$/;
const requireValue = (value, message) => { if (!value) throw new Error(message); };

export async function waitForNpmVersion({ version, expectedIntegrity, budgetMs = 300_000, intervalMs = 3000 }, {
  fetchImpl = fetch, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  requireValue(/^\d+\.\d+\.\d+$/.test(version), 'Invalid npm release version');
  requireValue(Number.isSafeInteger(budgetMs) && budgetMs > 0 && budgetMs <= 300_000 &&
    Number.isSafeInteger(intervalMs) && intervalMs > 0 && intervalMs <= 30_000, 'Invalid npm visibility deadline');
  requireValue(expectedIntegrity === undefined || integrityPattern.test(expectedIntegrity), 'Invalid expected npm integrity');
  const started = now();
  const remaining = () => {
    const left = budgetMs - (now() - started);
    requireValue(left > 0, `npm version is not publicly visible within ${budgetMs}ms`);
    return left;
  };
  const get = async (url, accept) => {
    const timeoutMs = Math.min(15_000, remaining());
    let response;
    try {
      response = await fetchImpl(url, { method: 'GET', redirect: 'error',
        headers: { Accept: accept, 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(timeoutMs) });
    } catch { throw new Error('npm visibility request failed (network, redirect or deadline)'); }
    if (response.status === 404) return undefined;
    requireValue(response.ok, `npm visibility failed: HTTP ${response.status}`);
    try { return await response.json(); }
    catch { throw new Error('Invalid npm visibility JSON'); }
  };
  const checkedIntegrity = entry => {
    requireValue(entry?.name === PACKAGE && entry.version === version && integrityPattern.test(entry.dist?.integrity), 'Invalid npm version metadata');
    if (expectedIntegrity !== undefined) requireValue(entry.dist.integrity === expectedIntegrity, 'npm artifact integrity mismatch');
    return entry.dist.integrity;
  };
  for (let attempts = 1; ; attempts++) {
    const exact = await get(`https://registry.npmjs.org/${PACKAGE}/${version}`, 'application/json');
    if (exact !== undefined) {
      const integrity = checkedIntegrity(exact);
      // npm pack resolves through this abbreviated packument, which can lag the exact endpoint.
      const packument = await get(`https://registry.npmjs.org/${PACKAGE}`, 'application/vnd.npm.install-v1+json');
      if (packument !== undefined) {
        requireValue(packument?.name === PACKAGE && packument.versions && typeof packument.versions === 'object' && !Array.isArray(packument.versions), 'Invalid npm packument');
        if (Object.hasOwn(packument.versions, version)) {
          requireValue(checkedIntegrity(packument.versions[version]) === integrity, 'npm packument integrity mismatch');
          remaining();
          return { package: PACKAGE, version, integrity, attempts, elapsedMs: now() - started };
        }
      }
    }
    // Only 404 or an otherwise valid packument missing this version reaches the retry.
    await sleep(Math.min(intervalMs, remaining()));
  }
}

async function main() {
  const args = process.argv.slice(2);
  requireValue((args.length === 2 || args.length === 4) && args[0] === '--version' &&
    (args.length === 2 || args[2] === '--expected-artifact'), 'Usage: --version VERSION [--expected-artifact DIR]');
  let expectedIntegrity;
  if (args[3]) {
    const directory = path.resolve(args[3]);
    const report = JSON.parse(readFileSync(path.join(directory, 'verification.json'), 'utf8'));
    const actual = 'sha512-' + createHash('sha512').update(readFileSync(path.join(directory, 'agenttoll-mcp.tgz'))).digest('base64');
    requireValue(report.package === PACKAGE && report.version === args[1] && report.integrity === actual, 'Verified npm artifact changed');
    expectedIntegrity = actual;
  }
  const result = await waitForNpmVersion({ version: args[1], expectedIntegrity });
  console.log(`Public npm metadata ready for ${PACKAGE}@${result.version} after ${result.attempts} read-only checks (${result.elapsedMs}ms)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
