// Read-only public upstream probe. Run from repository root:
// node --import tsx docs/remediation/2026-09-14/data-quality-live.mjs
// Prints evidence; never contacts the paid API or loads a wallet/key.
import { getScorecard } from '../../../src/services/history.ts';
import { getTokenSafety } from '../../../src/services/safety.ts';
import { requestContext } from '../../../src/request-context.ts';

const results = [];
for (const [name, load] of [
  ['scorecard', () => getScorecard('7')],
  ['safety', () => getTokenSafety('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913')],
]) {
  const context = { requestId: 'data-quality-read-only', signal: AbortSignal.timeout(25000), upstreamCalls: 0, cacheHits: 0, cacheMisses: 0, coalescedLoads: 0 };
  const start = Date.now();
  try {
    const result = await requestContext.run(context, load);
    results.push({ name, ms: Date.now() - start, upstreamCalls: context.upstreamCalls, result });
  } catch (error) {
    results.push({ name, ms: Date.now() - start, upstreamCalls: context.upstreamCalls, error: error.name });
    process.exitCode = 1;
  }
}
console.log(JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
