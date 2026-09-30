import { readFileSync, statSync } from 'node:fs';
import { summarizeInspectionLogs } from '../src/inspection-report.js';

const MAX_INPUTS = 64;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;

try {
  const inputs = [];
  const excludedOperators = [];
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (!value || !['--input', '--exclude-operator'].includes(flag)) {
      throw new Error('Usage: node --import tsx scripts/inspection-report.mjs --input <ndjson> [--input <ndjson> ...] [--exclude-operator <0x-address> ...]');
    }
    if (flag === '--input') inputs.push(value);
    else excludedOperators.push(value);
  }
  if (!inputs.length || inputs.length > MAX_INPUTS) throw new Error(`Provide between 1 and ${MAX_INPUTS} --input files.`);
  if (excludedOperators.length > 128) throw new Error('Provide at most 128 --exclude-operator addresses.');
  let totalBytes = 0;
  const contents = inputs.map(file => {
    const stat = statSync(file);
    if (!stat.isFile()) throw new Error(`Input must be a regular file: ${file}`);
    const bytes = stat.size;
    if (bytes > MAX_FILE_BYTES) throw new Error(`Each input must be at most ${MAX_FILE_BYTES / 1024 / 1024} MiB: ${file}`);
    totalBytes += bytes;
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error(`Combined inputs must be at most ${MAX_TOTAL_BYTES / 1024 / 1024} MiB.`);
    return readFileSync(file, 'utf8');
  });
  console.log(JSON.stringify(summarizeInspectionLogs(contents, excludedOperators), null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
