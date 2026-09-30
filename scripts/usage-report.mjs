import { readFileSync, statSync } from 'node:fs';
import { summarizeUsageLogs } from '../src/usage-report.js';

try {
  const inputs = [], operators = [];
  let format = 'json';
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i], value = args[i + 1];
    if (!value || !['--input', '--exclude-operator', '--format'].includes(flag)) {
      throw new Error('Usage: npm run ops:usage -- --input <ndjson> [--input <ndjson> ...] [--exclude-operator <address>] [--format json|markdown]');
    }
    if (flag === '--input') inputs.push(value);
    else if (flag === '--exclude-operator') operators.push(value);
    else format = value;
  }
  if (!['json', 'markdown'].includes(format)) throw new Error('Format must be json or markdown.');
  if (!inputs.length || inputs.length > 64) throw new Error('Provide between 1 and 64 input files.');
  if (operators.length > 128) throw new Error('Provide at most 128 additional operator wallets.');
  let total = 0;
  const contents = inputs.map(file => {
    const stat = statSync(file);
    if (!stat.isFile() || stat.size > 20 * 1024 * 1024) throw new Error('Each input must be a regular file of at most 20 MiB.');
    total += stat.size;
    if (total > 100 * 1024 * 1024) throw new Error('Combined inputs must not exceed 100 MiB.');
    return readFileSync(file, 'utf8');
  });
  const report = summarizeUsageLogs(contents, operators);
  if (!report.input.matchingRecords) throw new Error('No usable paid-endpoint request records were supplied.');
  if (format === 'json') console.log(JSON.stringify(report, null, 2));
  else {
    const summary = report.settlements;
    const lines = ['# AgentToll usage report', '',
      `Supplied log window (UTC): ${report.window.firstRequestAt} to ${report.window.lastRequestAt}.`, '',
      `External wallets: **${summary.wallets.external}**; returning on distinct UTC dates: **${summary.wallets.returningExternal}**.`,
      `Confirmed mainnet USDC: **${summary.usdc.external} external**, ${summary.usdc.knownOperator} known operator.`,
      `Unique settlements: ${summary.confirmedUnique}; completed responses: ${summary.successfullyDeliveredReports}; settled but aborted: ${summary.settledButAborted}.`,
      `Unsigned quotes: ${report.requests.quotes}; signed submissions: ${report.requests.signedSubmissions}; signed failures without a receipt claim: ${report.failures.total}.`,
      `Excluded testnet settlements: ${summary.excludedTestnet.confirmedUnique}; unresolved settlement records: ${summary.unresolved.totalRecords}; conflicting request IDs: ${report.input.conflictingRequestIds}.`, '',
      '## Daily mainnet activity', '',
      '| UTC date | External wallets | External settlements | External USDC | Operator USDC |',
      '|---|---:|---:|---:|---:|',
      ...report.daily.map(row => `| ${row.date} | ${row.external.wallets} | ${row.external.settlements} | ${row.external.usdc} | ${row.knownOperator.usdc} |`), '',
      '## Paid endpoints', '',
      '| Endpoint | Quotes | Signed failures | External deliveries | External USDC | Operator USDC |',
      '|---|---:|---:|---:|---:|---:|',
      ...report.byEndpoint.map(row => `| ${row.route} | ${row.quotes} | ${row.signedFailures} | ${row.external.deliveredResponses} | ${row.external.usdc} | ${row.knownOperator.usdc} |`), '',
      '## Weekly external usage', '',
      '| UTC Monday | External wallets | Also observed previous week | External USDC |',
      '|---|---:|---:|---:|',
      ...report.weekly.map(row => `| ${row.weekStarting} | ${row.external.wallets} | ${row.returningFromPreviousWeek} | ${row.external.usdc} |`), '',
      '## Interpretation', '', ...report.notes.map(note => `- ${note}`), ''];
    console.log(lines.join('\n'));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
