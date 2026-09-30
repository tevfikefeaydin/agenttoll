import { checkDataQuality } from '../src/operations-data.js';

try {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--strict') || args.length > 1) throw new Error('Usage: npm run ops:data -- [--strict]');
  const report = await checkDataQuality();
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = !report.ok ? 1 : args.includes('--strict') && report.degraded ? 2 : 0;
} catch {
  console.error('Data quality check failed; use npm run ops:data -- [--strict].');
  process.exitCode = 1;
}
