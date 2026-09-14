// Read-only release probes. Neither value is a valid payment or signature.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';

const probes = [];
for (const [name, header, expected] of [
  ['legacy', 'X-PAYMENT', 'PAYMENT_UPGRADE_REQUIRED'],
  ['malformed', 'PAYMENT-SIGNATURE', 'MALFORMED_PAYMENT'],
]) {
  const started = Date.now();
  const response = await fetch('https://agenttoll.app/api/feargreed', {
    headers: { [header]: 'agenttoll-audit-invalid-payment', 'X-AgentToll-Client': 'agenttoll-mcp/0.14.0' },
    signal: AbortSignal.timeout(10_000), redirect: 'error',
  });
  const body = await response.json();
  assert.equal(response.status, 402);
  assert.equal(body.code, expected);
  assert.equal(body.retryable, false);
  assert.match(body.requestId, /^[a-f0-9-]{36}$/);
  assert.equal(response.headers.get('payment-response'), null);
  probes.push({ name, header, status: response.status, ms: Date.now() - started, body,
    receiptPresent: false, clientLabel: 'Synthetic self-reported version to verify bounded metadata parsing' });
}
const result = { checkedAt: new Date().toISOString(), scope: 'Invalid, unsigned diagnostic probes; no real authorization or payment', probes };
writeFileSync(new URL('live-diagnostic-probes.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
