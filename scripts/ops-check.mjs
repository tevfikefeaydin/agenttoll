import { checkService } from '../src/operations-check.js';

try {
  if (process.argv.length > 2) throw new Error('Usage: npm run ops:check (optional AGENTTOLL_URL, AGENTTOLL_NETWORK, AGENTTOLL_RECIPIENT environment variables)');
  const report = await checkService({ baseUrl: process.env.AGENTTOLL_URL, network: process.env.AGENTTOLL_NETWORK,
    recipient: process.env.AGENTTOLL_RECIPIENT });
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
