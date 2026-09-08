import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const files = readdirSync(new URL('../tests/', import.meta.url)).filter(file => file.endsWith('.test.ts')).sort().map(file => `tests/${file}`);
if (!files.length) throw new Error('No regression tests found');
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=4', ...files], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
