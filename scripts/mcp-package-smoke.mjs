// npm run smoke:mcp [-- --artifact-dir DIR | --tarball FILE |
//   --registry-version VERSION --expected-artifact DIR | --verify-artifact DIR]
// Build/pack once, independently install and test those bytes, then publish those bytes.
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyConsumer } from './mcp-package-consumer.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const values = {};
while (args.length) {
  const option = args.shift();
  assert.ok(['--artifact-dir', '--tarball', '--registry-version', '--expected-artifact', '--verify-artifact'].includes(option), `Unknown option ${option}`);
  const value = args.shift();
  assert.ok(value && !value.startsWith('--'), `Missing value for ${option}`);
  assert.ok(!(option in values), `Duplicate ${option}`);
  values[option] = value;
}
const integrity = file => 'sha512-' + createHash('sha512').update(readFileSync(file)).digest('base64');
function verifiedArtifact(directory) {
  const report = JSON.parse(readFileSync(path.join(directory, 'verification.json'), 'utf8'));
  assert.equal(report.package, 'agenttoll-mcp');
  assert.equal(report.filename, 'agenttoll-mcp.tgz');
  assert.equal(report.integrity, integrity(path.join(directory, report.filename)), 'Verified tarball changed');
  assert.equal(report.consumer.version, report.version);
  assert.equal(report.consumer.cases.length, 7);
  if (process.env.RELEASE_TAG) assert.equal(process.env.RELEASE_TAG, `mcp-v${report.version}`);
  return report;
}
if (values['--verify-artifact']) {
  const report = verifiedArtifact(path.resolve(values['--verify-artifact']));
  console.log(`Verified immutable agenttoll-mcp@${report.version}: ${report.integrity}`);
} else {
  assert.ok(!(values['--tarball'] && values['--registry-version']), 'Choose a local tarball or registry version');
  assert.ok(!values['--expected-artifact'] || values['--registry-version'], 'Expected artifact requires registry verification');
  if (!process.env.npm_execpath) throw new Error('Run this check with npm run smoke:mcp');
  // A fresh installation must never inherit a repository or global ancestor dependency tree.
  const temporaryRoot = realpathSync(tmpdir());
  for (let ancestor = temporaryRoot; ; ancestor = path.dirname(ancestor)) {
    assert.ok(!existsSync(path.join(ancestor, 'node_modules')), `Temporary directory has ancestor node_modules: ${ancestor}`);
    if (path.dirname(ancestor) === ancestor) break;
  }
  const sandbox = mkdtempSync(path.join(temporaryRoot, 'agenttoll-consumer-'));
  const npm = (argv, cwd = sandbox) => {
    const env = { ...process.env, NODE_PATH: '', NODE_OPTIONS: '', NPM_CONFIG_UPDATE_NOTIFIER: 'false' };
    // Package lifecycle scripts are disabled; runtime children receive a separate key-free allowlist.
    const result = spawnSync(process.execPath, [process.env.npm_execpath, ...argv], { cwd, env, encoding: 'utf8', timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
    if (result.status !== 0) throw new Error(`npm ${argv[0]} failed: ${result.error?.message ?? result.stderr}`);
    return result.stdout;
  };
  try {
    let tarball;
    let metadata;
    const expected = values['--expected-artifact'] ? verifiedArtifact(path.resolve(values['--expected-artifact'])) : undefined;
    const version = values['--registry-version'] ?? JSON.parse(readFileSync(path.join(root, 'mcp/package.json'), 'utf8')).version;
    assert.match(version, /^\d+\.\d+\.\d+$/);
    if (expected) assert.equal(version, expected.version);
    if (values['--tarball']) {
      tarball = path.resolve(values['--tarball']);
    } else {
      const source = values['--registry-version'] ? `agenttoll-mcp@${version}` : '.';
      [metadata] = JSON.parse(npm(['pack', source, '--json', '--ignore-scripts', '--prefer-online', '--registry=https://registry.npmjs.org', '--pack-destination', sandbox], values['--registry-version'] ? sandbox : path.join(root, 'mcp')));
      assert.equal(metadata.version, version);
      assert.equal(path.basename(metadata.filename), metadata.filename);
      for (const file of ['dist/server.js', 'dist/payment-policy.js', 'dist/endpoint-manifest.js', 'dist/version.js']) {
        assert.ok(metadata.files.some(entry => entry.path === file), `Missing ${file}`);
      }
      assert.ok(metadata.files.every(entry => !entry.path.startsWith('/') && !entry.path.split('/').includes('..')), 'Unsafe archive member');
      tarball = path.join(sandbox, metadata.filename);
      assert.equal(integrity(tarball), metadata.integrity);
    }
    const testedIntegrity = integrity(tarball);
    if (expected) assert.equal(testedIntegrity, expected.integrity, 'Registry bytes differ from tested release artifact');
    writeFileSync(path.join(sandbox, 'package.json'), JSON.stringify({ name: 'agenttoll-consumer-verification', version: '1.0.0', private: true }));
    console.log(`Installing actual agenttoll-mcp@${version} tarball with freshly resolved dependencies outside the repository...`);
    npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=true', '--registry=https://registry.npmjs.org', tarball]);
    const consumer = await verifyConsumer(sandbox, version);
    assert.equal(integrity(tarball), testedIntegrity, 'Tarball changed while being tested');
    const report = { package: 'agenttoll-mcp', version, filename: 'agenttoll-mcp.tgz', integrity: testedIntegrity,
      verifiedAt: new Date().toISOString(), source: values['--registry-version'] ? 'public-npm' : 'local-tarball',
      isolation: 'Fresh npm install in an OS temporary directory with no ancestor node_modules; runtime network blocked; unfunded ephemeral keys only.', consumer };
    if (values['--artifact-dir']) {
      const destination = path.resolve(values['--artifact-dir']);
      mkdirSync(destination, { recursive: true });
      for (const filename of ['agenttoll-mcp.tgz', 'verification.json']) assert.ok(!existsSync(path.join(destination, filename)), `Refusing to overwrite release artifact ${filename}`);
      copyFileSync(tarball, path.join(destination, 'agenttoll-mcp.tgz'));
      writeFileSync(path.join(destination, 'verification.json'), JSON.stringify(report, null, 2) + '\n');
      verifiedArtifact(destination);
      console.log(`Verified release artifact retained at ${destination}`);
    }
    console.log(JSON.stringify(report, null, 2));
  } finally {
    const resolved = realpathSync(sandbox);
    const relative = path.relative(temporaryRoot, resolved);
    assert.ok(relative.startsWith('agenttoll-consumer-') && !relative.includes(path.sep) && !path.isAbsolute(relative), 'Unsafe consumer cleanup target');
    rmSync(resolved, { recursive: true, force: true });
  }
}
