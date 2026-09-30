import { readFileSync, statSync } from 'node:fs';
import { summarizeRequests } from '../src/operations-report.js';

try {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--input') throw new Error('Usage: npm run ops:report -- --input requests.ndjson');
  if (statSync(args[1]).size > 20 * 1024 * 1024) throw new Error('Split log exports into files of at most 20 MiB.');
  const report = summarizeRequests(readFileSync(args[1], 'utf8'));
  console.log(JSON.stringify(report, null, 2));
  if (!report.requests) process.exitCode = 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
