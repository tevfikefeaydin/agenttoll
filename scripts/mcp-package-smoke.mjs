// Inspect and run the actual npm tarball with installed package dependencies.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const packageRoot = path.join(root, 'mcp');
const cache = path.resolve(packageRoot, 'node_modules', '.cache');
mkdirSync(cache, { recursive: true });
const sandbox = mkdtempSync(path.join(cache, 'agenttoll-package-'));
let client;
let watchdog;
try {
  if (!process.env.npm_execpath) throw new Error('Run this check with npm run smoke:mcp');
  const packed = spawnSync(process.execPath, [process.env.npm_execpath, 'pack', '--json', '--pack-destination', sandbox], { cwd: packageRoot, encoding: 'utf8' });
  if (packed.status !== 0) throw new Error(packed.stderr || 'npm pack failed');
  const [metadata] = JSON.parse(packed.stdout);
  for (const file of ['dist/server.js', 'dist/payment-policy.js', 'dist/endpoint-manifest.js', 'dist/version.js']) assert.ok(metadata.files.some(entry => entry.path === file), `Missing ${file}`);
  assert.ok(metadata.files.every(entry => !entry.path.startsWith('/') && !entry.path.split('/').includes('..')), 'Unsafe archive member');
  // Windows tar can mis-decode Unicode absolute arguments (e.g. Çalışma Alanı).
  // Node sets the working directory with the native Unicode API; keep tar's
  // archive argument relative to that directory and avoid a second path decode.
  assert.equal(path.basename(metadata.filename), metadata.filename, 'Unsafe archive filename');
  const extracted = spawnSync('tar', ['-xf', metadata.filename], { cwd: sandbox, encoding: 'utf8' });
  if (extracted.status !== 0) throw new Error(extracted.stderr || 'tar extraction failed');
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [path.join(sandbox, 'package', 'dist', 'server.js')],
    env: { AGENTTOLL_URL: 'https://audit.invalid', AGENTTOLL_NETWORK: 'base-sepolia', AGENTTOLL_RECIPIENT: '0x1111111111111111111111111111111111111111' }, stderr: 'pipe' });
  client = new Client({ name: 'offline-package-smoke', version: '1.0.0' });
  await Promise.race([client.connect(transport), new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error('MCP startup timed out')), 10_000); })]);
  clearTimeout(watchdog);
  const version = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).version;
  assert.equal(client.getServerVersion()?.version, version);
  const { tools } = await client.listTools();
  assert.equal(tools.length, 23);
  const result = await client.callTool({ name: 'get_payment_budget', arguments: {} });
  const budget = JSON.parse(result.content[0].text);
  assert.equal(budget.remainingUsdc, '1.000000');
  console.log(`Packed MCP ${version}: 23 tools, quote-only startup and budget callback passed. No payment or upstream request.`);
} finally {
  clearTimeout(watchdog);
  await client?.close();
  // Only this newly created extraction directory may be deleted.
  const resolved = realpathSync(sandbox);
  const relative = path.relative(realpathSync(cache), resolved);
  if (relative.startsWith('agenttoll-package-') && !relative.includes(path.sep) && !path.isAbsolute(relative)) rmSync(resolved, { recursive: true, force: true });
}
