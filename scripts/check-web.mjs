import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const result = await build({ absWorkingDir: fileURLToPath(new URL('../', import.meta.url)), entryPoints: ['web/demo.ts'], bundle: true, format: 'iife', target: 'es2020', minify: true, write: false });
const committed = readFileSync(new URL('../public/demo.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
if (result.outputFiles[0].text !== committed) { console.error('public/demo.js is stale; run npm run build:web'); process.exitCode = 1; }
else console.log('Browser bundle agrees with its typed source.');
