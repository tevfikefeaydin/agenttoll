// Preserve generated public JSON, then replay only that capture onto current main.
// Never rerun a paid capture, force-push, or overwrite a divergent remote capture.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const allowed = (kind, file) => kind === 'stats' ? file === 'data/stats.json' : /^data\/scout\/\d{4}-\d{2}-\d{2}\.json$/.test(file);
function git(cwd, args, check = true) {
  const result = spawnSync('git', args, { cwd, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
  // Auth configuration and remote diagnostics must not enter capture artifacts/logs.
  if (check && result.status !== 0) throw new Error(`Snapshot git ${args[0]} failed; saved capture is retained`);
  return result;
}
function atRevision(cwd, revision, file) {
  const result = git(cwd, ['show', `${revision}:${file}`], false);
  if (result.status === 0) return result.stdout;
  // A missing path is expected for a newly captured date; other git errors fail.
  if (git(cwd, ['cat-file', '-e', `${revision}^{commit}`], false).status !== 0) throw new Error('Cannot read snapshot baseline revision');
  return null;
}
function artifactPath(cwd, directory) {
  const resolved = path.resolve(directory);
  const relative = path.relative(cwd, resolved);
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new Error('Capture artifact directory must be outside the checkout');
  }
  return resolved;
}

export function captureSnapshot(kind, directory, cwd = process.cwd()) {
  if (!['scout', 'stats'].includes(kind)) throw new Error('Expected scout or stats capture');
  const artifact = artifactPath(cwd, directory);
  if (existsSync(path.join(artifact, 'capture.json'))) throw new Error('Refusing to overwrite a saved capture');
  mkdirSync(artifact, { recursive: true, mode: 0o700 });
  const prefix = kind === 'scout' ? 'data/scout' : 'data/stats.json';
  const changed = Buffer.concat([
    git(cwd, ['diff', '--name-only', '-z', 'HEAD', '--', prefix]).stdout,
    git(cwd, ['ls-files', '--others', '--exclude-standard', '-z', '--', prefix]).stdout,
  ]).toString().split('\0').filter(file => allowed(kind, file));
  const revision = git(cwd, ['rev-parse', 'HEAD']).stdout.toString().trim();
  const files = [];
  for (const file of [...new Set(changed)].sort()) {
    if (!existsSync(path.join(cwd, file))) throw new Error('Generated snapshot was deleted; publication refused');
    const bytes = readFileSync(path.join(cwd, file));
    const target = path.join(artifact, file);
    mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
    const baseline = atRevision(cwd, revision, file);
    files.push({ path: file, sha256: digest(bytes), baselineSha256: baseline === null ? null : digest(baseline) });
  }
  const manifest = { schemaVersion: 1, kind, sourceRevision: revision, capturedAt: new Date().toISOString(), files };
  writeFileSync(path.join(artifact, 'capture.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(`Preserved ${files.length} generated ${kind} file(s) before publication`);
  return manifest;
}

export function publishSnapshot(directory, cwd = process.cwd()) {
  if (process.env.GITHUB_ACTIONS === 'true' && process.env.GITHUB_REF !== 'refs/heads/main') {
    throw new Error('Snapshot publication requires the main branch');
  }
  const artifact = artifactPath(cwd, directory);
  const manifest = JSON.parse(readFileSync(path.join(artifact, 'capture.json'), 'utf8'));
  if (manifest.schemaVersion !== 1 || !['scout', 'stats'].includes(manifest.kind) || !Array.isArray(manifest.files)) throw new Error('Invalid saved capture');
  const captures = manifest.files.map(entry => {
    if (!allowed(manifest.kind, entry.path) || !/^[a-f0-9]{64}$/.test(entry.sha256) ||
        !(entry.baselineSha256 === null || /^[a-f0-9]{64}$/.test(entry.baselineSha256))) throw new Error('Invalid saved capture entry');
    const bytes = readFileSync(path.join(artifact, entry.path));
    if (digest(bytes) !== entry.sha256) throw new Error('Saved capture changed; publication refused');
    JSON.parse(bytes.toString());
    return { ...entry, bytes };
  });
  if (!captures.length) { console.log('No newly captured data to publish'); return; }
  const temporary = mkdtempSync(path.join(tmpdir(), 'agenttoll-snapshot-publish-'));
  const checkout = path.join(temporary, 'checkout');
  let added = false;
  try {
    for (let attempt = 1; attempt <= 3; attempt++) {
      git(cwd, ['fetch', '--no-tags', 'origin', 'refs/heads/main']);
      const head = git(cwd, ['rev-parse', 'FETCH_HEAD']).stdout.toString().trim();
      if (!/^[a-f0-9]{40}$/.test(head)) throw new Error('Invalid fetched main revision');
      if (!added) { git(cwd, ['worktree', 'add', '--detach', checkout, head]); added = true; }
      else git(checkout, ['reset', '--hard', head]);
      const changed = [];
      for (const capture of captures) {
        const remote = atRevision(checkout, head, capture.path);
        const remoteDigest = remote === null ? null : digest(remote);
        if (remoteDigest === capture.sha256) continue;
        if (remoteDigest !== capture.baselineSha256) {
          throw new Error(`Remote ${capture.path} changed independently; saved capture retained for review`);
        }
        const target = path.join(checkout, capture.path);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, capture.bytes);
        changed.push(capture.path);
      }
      if (manifest.kind === 'scout') {
        const dates = readdirSync(path.join(checkout, 'data/scout')).filter(file => /^\d{4}-\d{2}-\d{2}\.json$/.test(file)).map(file => file.slice(0, 10)).sort();
        const indexFile = path.join(checkout, 'data/scout/index.json');
        let previousDates;
        try { previousDates = JSON.parse(readFileSync(indexFile, 'utf8')).dates; } catch { /* Rebuild a missing/broken index. */ }
        if (changed.length || JSON.stringify(previousDates) !== JSON.stringify(dates)) {
          writeFileSync(indexFile, JSON.stringify({ dates, updatedAt: new Date().toISOString() }, null, 2) + '\n');
          changed.push('data/scout/index.json');
        }
      }
      if (!changed.length) { console.log('Captured data is already published'); return; }
      git(checkout, ['add', '--', ...changed]);
      const label = manifest.kind === 'scout' ? 'Scout snapshot' : 'Toll baseline';
      git(checkout, ['-c', 'user.name=Tevfik Efe Aydin', '-c', 'user.email=tevfikefe.aydin@gmail.com',
                    'commit', '-m', `${label}: ${manifest.capturedAt.slice(0, 10)}`]);
      const pushed = git(checkout, ['push', 'origin', 'HEAD:refs/heads/main'], false);
      if (pushed.status === 0) { console.log(`Published preserved ${manifest.kind} capture on attempt ${attempt}`); return; }
      // Rebase only preserved data onto a fresh main, with the same conflict
      // check on each retry. The application checkout and saved bytes stay intact.
    }
    throw new Error('Snapshot push failed after three attempts; saved capture retained for recovery');
  } finally {
    if (added) git(cwd, ['worktree', 'remove', '--force', checkout], false);
    rmSync(temporary, { recursive: true, force: true });
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 4 && args[0] === '--capture' && args[2] === '--artifact-dir') captureSnapshot(args[1], args[3]);
  else if (args.length === 2 && args[0] === '--publish') publishSnapshot(args[1]);
  else throw new Error('Usage: --capture scout|stats --artifact-dir DIR, or --publish DIR');
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
