// Loaded only by the package verification subprocess, never shipped in the package.
// Complete offline boundary: no fetch forwarding and no outbound socket connections.
import { appendFileSync } from 'node:fs';
import net from 'node:net';
const event = data => appendFileSync(process.env.MCP_TEST_EVENTS, JSON.stringify(data) + '\n');
net.Socket.prototype.connect = function () {
  event({ type: 'blocked-network' });
  throw new Error('Package fixture prohibits network connections');
};
const mode = process.env.MCP_TEST_MODE;
event({ type: 'fixture-started' });
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.origin !== 'https://audit.invalid') {
    event({ type: 'blocked-origin' });
    throw new Error('Package fixture prohibits unexpected origins');
  }
  const signed = request.headers.has('payment-signature') || request.headers.has('x-payment');
  // Never record keys, authorization payloads, signatures or query values.
  event({ type: signed ? 'signed-retry' : 'unsigned-request', client: request.headers.get('x-agenttoll-client') });
  request.signal.addEventListener('abort', () => event({ type: 'http-aborted' }), { once: true });
  if (signed) return Response.json({ offlineFixture: true, symbol: 'eth', usd: 2000 });
  if (mode === 'timeout' || mode === 'cancellation') {
    // Deliberately ignore abort and deliver the late quote: the client must guard signing.
    await new Promise(resolve => setTimeout(resolve, 400));
    event({ type: 'late-quote', aborted: request.signal.aborted });
  }
  const quote = {
    x402Version: 2,
    resource: { url: request.url, mimeType: 'application/json' },
    accepts: [{ scheme: 'exact', network: 'eip155:84532',
      amount: mode === 'overcharge' ? '100000' : '1000',
      asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      payTo: mode === 'recipient' ? '0x2222222222222222222222222222222222222222' : '0x1111111111111111111111111111111111111111',
      maxTimeoutSeconds: 60, extra: { name: 'USDC', version: '2' } }],
  };
  return new Response(null, { status: 402, headers: { 'payment-required': Buffer.from(JSON.stringify(quote)).toString('base64') } });
};
