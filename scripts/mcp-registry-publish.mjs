// Narrow official Registry API client. Tokens stay in memory and never enter logs/files.
// Protocol: https://registry.modelcontextprotocol.io/openapi.json
// OIDC audience/exchange: modelcontextprotocol/registry cmd/publisher/auth/github-oidc.go
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const REGISTRY = 'https://registry.modelcontextprotocol.io';
const REPOSITORY = 'tevfikefeaydin/agenttoll';
const NAME = 'io.github.tevfikefeaydin/agenttoll';
const PACKAGE = 'agenttoll-mcp';
const MODES = ['keyless', 'zero-budget', 'recipient', 'overcharge', 'timeout', 'cancellation', 'normal'];
const requireValue = (condition, message) => { if (!condition) throw new Error(message); };
const repositoryMatches = repository => typeof repository?.url === 'string' &&
  repository.url.replace(/^git\+/, '').replace(/\.git$/, '') === `https://github.com/${REPOSITORY}`;

function validateRelease({ server, pkg, tag, repository, verification, tarballIntegrity, env }) {
  requireValue(env.GITHUB_ACTIONS === 'true', 'Registry publishing requires GitHub Actions');
  requireValue(repository === REPOSITORY, 'Unexpected release repository');
  requireValue(/^mcp-v\d+\.\d+\.\d+$/.test(tag) && tag === `mcp-v${pkg.version}`, 'Release tag/version mismatch');
  requireValue(pkg.name === PACKAGE && pkg.mcpName === NAME && repositoryMatches(pkg.repository), 'Invalid npm package identity or repository');
  requireValue(server.name === NAME && server.version === pkg.version && repositoryMatches(server.repository) && server.repository.source === 'github', 'Invalid registry namespace/version/repository');
  requireValue(server.packages?.length === 1 && server.packages[0].registryType === 'npm' &&
    server.packages[0].identifier === PACKAGE && server.packages[0].version === pkg.version &&
    server.packages[0].transport?.type === 'stdio', 'Invalid registry npm package/transport');
  requireValue(verification.package === PACKAGE && verification.source === 'public-npm' &&
    verification.version === pkg.version && verification.integrity === tarballIntegrity &&
    /^sha512-[A-Za-z0-9+/]{86}==$/.test(tarballIntegrity), 'Public npm consumer evidence/integrity mismatch');
  requireValue(verification.consumer?.version === pkg.version && verification.consumer.cases?.length === MODES.length &&
    MODES.every(mode => {
      const cases = verification.consumer.cases.filter(entry => entry.mode === mode);
      return cases.length === 1 && cases[0].version === pkg.version && cases[0].tools === 23 &&
        cases[0].signedRetries === (mode === 'normal' ? 1 : 0);
    }), 'Incomplete or failed public npm policy verification');
}

function normalizeServer(server) {
  const normalized = structuredClone(server);
  // Official Go model.Input uses omitempty for these false-valued booleans.
  // Preserve every other field; missing/changed configuration must fail verification.
  for (const pkg of normalized?.packages ?? []) {
    for (const variable of pkg.environmentVariables ?? []) {
      for (const key of ['isRequired', 'isSecret']) if (variable[key] === false) delete variable[key];
    }
  }
  return normalized;
}

function verifyRecord(record, server) {
  requireValue(record?._meta?.['io.modelcontextprotocol.registry/official']?.status === 'active', 'Public registry record is not active');
  requireValue(isDeepStrictEqual(normalizeServer(record.server), normalizeServer(server)), 'Public registry server differs from release metadata');
}

export async function publishRegistry(context, fetchImpl = fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms))) {
  validateRelease(context);
  const { server, pkg, verification, env } = context;
  const exactUrl = `${REGISTRY}/v0.1/servers/${encodeURIComponent(NAME)}/versions/${encodeURIComponent(pkg.version)}`;
  const request = async (stage, url, init = {}, allowMissing = false) => {
    let response;
    try {
      response = await fetchImpl(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(15_000) });
    } catch { throw new Error(`${stage} request failed (network, redirect or deadline)`); }
    if (allowMissing && response.status === 404) return undefined;
    requireValue(response.ok, `${stage} failed: HTTP ${response.status}`);
    try { return await response.json(); }
    catch { throw new Error(`${stage} returned invalid JSON`); }
  };
  const npm = await request('Public npm metadata', `https://registry.npmjs.org/${PACKAGE}/${encodeURIComponent(pkg.version)}`);
  requireValue(npm.name === PACKAGE && npm.version === pkg.version && npm.mcpName === NAME &&
    repositoryMatches(npm.repository) && npm.dist?.integrity === verification.integrity, 'Public npm identity/repository/integrity mismatch');
  const existing = await request('Public registry lookup', exactUrl, {}, true);
  const result = (action, record) => ({ action, name: NAME, version: pkg.version, url: exactUrl,
    npmIntegrity: verification.integrity, verifiedAt: new Date().toISOString(),
    registryStatus: 'active', server: record.server });
  if (existing) {
    verifyRecord(existing, server);
    return result('already-published', existing);
  }

  // The only credential request occurs after release and public npm validation.
  requireValue(Boolean(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN && env.ACTIONS_ID_TOKEN_REQUEST_URL), 'GitHub OIDC requires id-token: write');
  let oidcUrl;
  try { oidcUrl = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL); }
  catch { throw new Error('Invalid GitHub OIDC endpoint'); }
  requireValue(oidcUrl.protocol === 'https:' && oidcUrl.hostname.endsWith('.actions.githubusercontent.com') &&
    !oidcUrl.username && !oidcUrl.password && !oidcUrl.hash && !oidcUrl.port, 'Unexpected GitHub OIDC endpoint');
  oidcUrl.searchParams.set('audience', REGISTRY);
  const oidc = await request('GitHub OIDC', oidcUrl.href, { headers: { Authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}`, Accept: 'application/json' } });
  requireValue(typeof oidc.value === 'string' && oidc.value.length > 0, 'GitHub OIDC token is missing');
  const exchanged = await request('Registry OIDC exchange', `${REGISTRY}/v0.1/auth/github-oidc`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ oidc_token: oidc.value }),
  });
  requireValue(typeof exchanged.registry_token === 'string' && exchanged.registry_token.length > 0, 'Registry OIDC token is missing');
  // Never retry a write automatically. A later registry-only run first checks the exact record.
  await request('Registry publish', `${REGISTRY}/v0.1/publish`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${exchanged.registry_token}` }, body: JSON.stringify(server),
  });
  for (let attempt = 0; attempt < 6; attempt++) {
    const published = await request('Public registry verification', exactUrl, {}, true);
    if (published) { verifyRecord(published, server); return result('published', published); }
    if (attempt < 5) await sleep(2000);
  }
  throw new Error('Published registry version was not publicly visible within the verification window');
}

async function main() {
  const args = process.argv.slice(2);
  requireValue(args.length === 4 && args[0] === '--evidence' && args[2] === '--output', 'Usage: node scripts/mcp-registry-publish.mjs --evidence DIR --output FILE');
  const root = fileURLToPath(new URL('../', import.meta.url));
  const tag = process.env.RELEASE_TAG;
  requireValue(/^mcp-v\d+\.\d+\.\d+$/.test(tag ?? ''), 'Invalid release tag');
  requireValue(process.env.GITHUB_REPOSITORY === REPOSITORY && process.env.GITHUB_ACTIONS === 'true', 'Registry publishing requires the canonical GitHub Actions repository');
  const git = args => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 10_000 });
    requireValue(result.status === 0, 'Cannot verify release Git revision');
    return result.stdout.trim();
  };
  requireValue(git(['rev-parse', 'HEAD']) === git(['rev-parse', `refs/tags/${tag}^{commit}`]), 'Checkout does not match release tag');
  // Publishing uses only the immutable tagged metadata, not workspace modifications.
  requireValue(git(['status', '--porcelain', '--', 'mcp/server.json', 'mcp/package.json']) === '', 'Release metadata has local modifications');
  const directory = path.resolve(args[1]);
  const verification = JSON.parse(readFileSync(path.join(directory, 'verification.json'), 'utf8'));
  const tarballIntegrity = 'sha512-' + createHash('sha512').update(readFileSync(path.join(directory, 'agenttoll-mcp.tgz'))).digest('base64');
  const result = await publishRegistry({
    server: JSON.parse(readFileSync(path.join(root, 'mcp/server.json'), 'utf8')),
    pkg: JSON.parse(readFileSync(path.join(root, 'mcp/package.json'), 'utf8')),
    tag, repository: process.env.GITHUB_REPOSITORY, verification, tarballIntegrity, env: process.env,
  });
  writeFileSync(path.resolve(args[3]), JSON.stringify(result, null, 2) + '\n');
  console.log(`Official MCP Registry ${result.action}: ${result.name}@${result.version}`);
  console.log(result.url);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
