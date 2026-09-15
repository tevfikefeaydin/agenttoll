import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { sanitizedClient } from '../src/payment-telemetry.js';
import { installPaymentDiagnosticFilter } from '../src/telemetry.js';

test('payment diagnostics use real middleware with offline facilitator fixtures', async (t) => {
  Object.assign(process.env, { DOTENV_CONFIG_PATH: 'agenttoll-audit-absent.env', ADDRESS: '0x' + '11'.repeat(20),
    NETWORK: 'base-sepolia', FACILITATOR_URL: 'https://facilitator.audit.invalid', REQUEST_TIMEOUT_MS: '300' });
  delete process.env.VERCEL;
  const nativeFetch = globalThis.fetch;
  const payer = '0x' + '22'.repeat(20);
  const claimed = '0x' + '33'.repeat(20);
  const transaction = '0x' + 'ab'.repeat(32);
  const secret = 'PRIVATE-SIGNATURE-QUERY-ERROR';
  let mode = 'abort-initialize';
  let verifyCalls = 0, settleCalls = 0;
  const logs: Record<string, any>[] = [];
  const consoleOutput: unknown[] = [];
  for (const level of ['log', 'warn', 'error'] as const) t.mock.method(console, level, (...args: unknown[]) => {
    consoleOutput.push(args);
    try { logs.push(JSON.parse(String(args[0]))); } catch {}
  });
  let entered!: () => void;
  let release!: () => void;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith('/supported')) {
      if (mode === 'abort-initialize') { entered(); await new Promise<void>(resolve => { release = resolve; }); }
      return Response.json({ kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:84532' }], extensions: [], signers: {} });
    }
    if (url.endsWith('/verify')) {
      verifyCalls++;
      if (mode === 'abort-verify') { entered(); await new Promise<void>(resolve => { release = resolve; }); }
      if (mode === 'timeout-verify') await new Promise(resolve => setTimeout(resolve, 400));
      if (mode === 'verify-decline') return Response.json({ isValid: false, invalidReason: 'invalid_exact_evm_payload_signature', payer: claimed }, { status: 400 });
      if (mode === 'sensitive-decline') return Response.json({ isValid: false, invalidReason: secret, invalidMessage: secret, payer: claimed }, { status: 400 });
      return Response.json({ isValid: true, payer: mode === 'invalid-identity' ? secret : payer }, mode === 'extension-response' ? {
        headers: { 'EXTENSION-RESPONSES': Buffer.from(JSON.stringify({ [secret]: { reason: { signature: secret }, code: secret } })).toString('base64') },
      } : undefined);
    }
    if (url.endsWith('/settle')) {
      settleCalls++;
      if (mode === 'abort-settle') { entered(); await new Promise<void>(resolve => { release = resolve; }); }
      if (mode === 'timeout-settle') await new Promise(resolve => setTimeout(resolve, 400));
      if (mode === 'settle-decline') return Response.json({ success: false, errorReason: 'insufficient_funds', transaction: secret, network: 'eip155:84532' }, { status: 400 });
      if (mode === 'settle-unknown') return Response.json({ private: secret });
      return Response.json({ success: true, transaction: mode === 'invalid-identity' ? secret : transaction,
        network: mode === 'inconsistent-settlement' ? 'eip155:1' : 'eip155:84532',
        amount: mode === 'inconsistent-settlement' ? '999' : undefined, payer });
    }
    if (url.includes('base.org')) {
      const body = JSON.parse(String(init?.body));
      return Response.json({ jsonrpc: '2.0', id: body.id, result: '0x64' });
    }
    if (mode === 'abort-handler' && url.includes('coingecko.com')) {
      entered(); await new Promise<void>(resolve => { release = resolve; });
      return Response.json({ ethereum: { usd: 2000 } });
    }
    throw new Error('Unexpected external IO');
  });
  const { default: app } = await import('../src/app.js');
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => { release?.(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  await t.test('disconnect while shared initialization is pending logs the abort and does not cancel other readers', async () => {
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const req = http.get(baseUrl + '/api/gas'); req.on('error', () => {});
    await reached; req.destroy();
    for (let i = 0; i < 50 && !logs.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(logs[0]?.terminal, 'abort'); assert.equal(logs[0]?.paymentPhase, 'initialize');
    assert.equal(logs[0]?.paymentStage, 'none'); assert.equal(logs[0]?.facilitatorVerifyCalls, 0);
    mode = 'healthy'; release();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(logs.filter(row => row.requestId === logs[0].requestId).length, 1);
  });
  const quote = await nativeFetch(baseUrl + '/api/gas');
  const required = JSON.parse(Buffer.from(quote.headers.get('payment-required')!, 'base64').toString());
  await quote.arrayBuffer();
  const payload = { x402Version: 2, accepted: required.accepts[0], payload: { signature: secret, authorization: { from: claimed } } };
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64');
  async function request(header = encode(payload), path = '/api/gas', name = 'payment-signature') {
    const res = await nativeFetch(baseUrl + path, { headers: { [name]: header, 'X-AgentToll-Client': 'agenttoll-mcp/0.14.0', 'User-Agent': secret } });
    const body = await res.json();
    const record = logs.find(row => row.requestId === res.headers.get('x-request-id'))!;
    return { res, body, record };
  }
  await t.test('v2 success records verified public identifiers and sanitized client metadata', async () => {
    const { res, record } = await request();
    assert.equal(res.status, 200);
    assert.equal(record.schemaVersion, 2);
    assert.equal(record.terminal, 'finish');
    assert.equal(record.paymentPhase, 'settle');
    assert.equal(record.paymentStage, 'settled');
    assert.equal(record.verifiedPayer, payer);
    assert.equal(record.settlementTransaction, transaction);
    assert.equal(record.settlementAmount, '1000');
    assert.equal(record.settlementAsset, '0x036cbd53842c5426634e7929541ec2318f3dcf7e');
    assert.equal(record.settlementNetwork, 'eip155:84532');
    assert.equal(record.facilitatorVerifyCalls, 1);
    assert.equal(record.facilitatorSettleCalls, 1);
    assert.ok(record.facilitatorVerifyMs >= 0);
    assert.deepEqual(record.client, { name: 'agenttoll-mcp', version: '0.14.0', source: 'x-agenttoll-client' });
  });
  await t.test('browser inspection client is allowlisted while settlement facts stay server-derived', async () => {
    const res = await nativeFetch(baseUrl + '/api/gas', { headers: {
      'payment-signature': encode({ ...payload, accepted: { ...payload.accepted, amount: '999', asset: '0x' + '44'.repeat(20), network: 'eip155:1' } }),
      'X-AgentToll-Client': 'agenttoll-inspect/1.0.0',
    } });
    await res.arrayBuffer();
    const record = logs.find(row => row.requestId === res.headers.get('x-request-id'))!;
    assert.equal(res.status, 402);
    assert.deepEqual(record.client, { name: 'agenttoll-inspect', version: '1.0.0', source: 'x-agenttoll-client' });
    assert.equal(record.settlementAmount, undefined);
    assert.equal(record.settlementAsset, undefined);
    assert.equal(record.settlementNetwork, undefined);
  });
  await t.test('decode and match rejections happen before verification without payload logging', async () => {
    const before = verifyCalls;
    for (const header of [Buffer.from('{"private":"' + secret).toString('base64'), encode(null)]) {
      const { res, record } = await request(header);
      assert.equal(res.status, 402); assert.equal(record.paymentPhase, 'parse'); assert.equal(record.paymentReason, 'malformed_payment');
    }
    const { record } = await request(encode({ ...payload, accepted: { ...payload.accepted, amount: '999' } }));
    assert.equal(record.paymentPhase, 'match'); assert.equal(record.paymentReason, 'requirements_mismatch');
    assert.equal(verifyCalls, before);
  });
  await t.test('legacy header and v1 payload receive explicit upgrade guidance', async () => {
    const before = verifyCalls;
    for (const [header, name] of [[encode({ x402Version: 1 }), 'x-payment'], [encode({ x402Version: 1 }), 'payment-signature']]) {
      const { res, body, record } = await request(header, '/api/gas', name);
      assert.equal(res.status, 402); assert.equal(body.code, 'PAYMENT_UPGRADE_REQUIRED');
      assert.match(body.error, /PAYMENT-SIGNATURE/); assert.equal(body.retryable, false);
      assert.equal(record.paymentReason, 'unsupported_version');
    }
    assert.equal(verifyCalls, before);
  });
  await t.test('extension mismatch is identified before facilitator verification', async () => {
    const before = verifyCalls;
    const { res, record } = await request(encode({ ...payload, extensions: { bazaar: { info: { private: secret } } } }));
    assert.equal(res.status, 402); assert.equal(record.paymentReason, 'extension_mismatch');
    assert.equal(record.paymentPhase, 'match'); assert.equal(verifyCalls, before);
  });
  await t.test('invalid public identifiers are omitted even in a successful facilitator response', async () => {
    mode = 'invalid-identity';
    const { res, record } = await request();
    assert.equal(res.status, 200); assert.equal(record.verifiedPayer, null); assert.equal(record.settlementTransaction, null);
    assert.equal(record.settlementAmount, undefined); assert.equal(record.settlementAsset, undefined);
  });
  await t.test('settlement facts are omitted when the facilitator receipt conflicts with server requirements', async () => {
    mode = 'inconsistent-settlement';
    const { res, record } = await request();
    assert.equal(res.status, 200); assert.equal(record.settlementTransaction, transaction);
    assert.equal(record.settlementAmount, undefined); assert.equal(record.settlementAsset, undefined);
    assert.equal(record.settlementNetwork, undefined);
  });
  await t.test('SDK extension-response diagnostics cannot print arbitrary facilitator reason values', async () => {
    mode = 'extension-response';
    const { res } = await request();
    assert.equal(res.status, 200);
    assert.doesNotMatch(JSON.stringify(consoleOutput), new RegExp(secret));
  });
  for (const [fixture, phase, reason] of [['verify-decline', 'verify', 'invalid_exact_evm_payload_signature'], ['sensitive-decline', 'verify', 'verification_declined'], ['settle-decline', 'settle', 'insufficient_funds'], ['settle-unknown', 'settle', 'facilitator_unavailable']]) {
    await t.test(fixture, async () => {
      mode = fixture;
      const { res, body, record } = await request();
      assert.equal(record.paymentPhase, phase); assert.equal(record.paymentReason, reason);
      assert.equal(record.settlementTransaction, null);
      if (phase === 'verify') assert.equal(record.verifiedPayer, null);
      if (fixture === 'settle-unknown') { assert.equal(res.status, 502); assert.equal(body.retryable, false); assert.equal(body.paymentOutcome, 'unknown'); }
      else assert.equal(res.status, 402);
    });
  }
  await t.test('handler errors do not settle and use handler phase', async () => {
    mode = 'healthy'; const before = settleCalls;
    const { res, record } = await request(encode(payload), '/api/gas?gasLimit=' + secret);
    assert.equal(res.status, 400); assert.equal(record.paymentPhase, 'handler'); assert.equal(record.paymentReason, 'handler_failed'); assert.equal(settleCalls, before);
  });
  for (const phase of ['verify', 'settle']) await t.test(`timeout during ${phase} preserves phase and settlement ambiguity`, async () => {
    mode = `timeout-${phase}`;
    const before = settleCalls;
    const { res, body, record } = await request();
    assert.equal(res.status, 504); assert.equal(record.paymentPhase, phase); assert.equal(record.paymentReason, 'request_timeout');
    assert.equal(record.terminal, 'finish'); assert.equal(record.settlementTransaction, null);
    if (phase === 'settle') { assert.equal(body.retryable, false); assert.equal(body.paymentOutcome, 'unknown'); assert.equal(settleCalls, before + 1); }
    else assert.equal(settleCalls, before);
    await new Promise(resolve => setTimeout(resolve, 120));
    assert.equal(logs.filter(row => row.requestId === record.requestId).length, 1);
  });
  for (const phase of ['verify', 'handler', 'settle']) await t.test(`disconnect during ${phase} logs once and late completion cannot fabricate settlement`, async () => {
    mode = `abort-${phase}`;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const count = logs.length;
    const before = settleCalls;
    const req = http.get(baseUrl + '/api/gas' + (phase === 'handler' ? '?gasLimit=21000' : ''), { headers: { 'payment-signature': encode(payload) } });
    req.on('error', () => {});
    await reached; req.destroy();
    for (let i = 0; i < 50 && logs.length === count; i++) await new Promise(resolve => setTimeout(resolve, 5));
    const record = logs[count];
    assert.equal(record.terminal, 'abort'); assert.equal(record.status, 499); assert.equal(record.abortReason, 'client_disconnected');
    assert.equal(record.paymentPhase, phase); assert.equal(record.paymentStage, phase === 'settle' ? 'unknown' : 'submitted');
    release(); await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(logs.filter(row => row.requestId === record.requestId).length, 1);
    assert.equal(record.settlementTransaction, null);
    assert.equal(settleCalls, before + (phase === 'settle' ? 1 : 0));
  });
  assert.doesNotMatch(JSON.stringify(consoleOutput), new RegExp(secret + '|' + claimed));
});

test('client labels are strictly bounded and self-reported metadata cannot carry free text', () => {
  assert.deepEqual(sanitizedClient(undefined, 'curl/8.14.1'), { name: 'curl', version: '8.14.1', source: 'user-agent' });
  for (const value of ['attacker/1.0.0', 'agenttoll-mcp/1.0.0 PRIVATE', 'agenttoll-mcp/1.0.0\nsecret', 'agenttoll-mcp/123456789.0', '0x' + '12'.repeat(20)]) {
    assert.equal(sanitizedClient(value, 'curl/8.14.1'), null);
    assert.equal(sanitizedClient(undefined, value), null);
  }
});

test('SDK diagnostic adapter preserves ordinary logs and all logs outside payment context', (t) => {
  const output: unknown[][] = [];
  t.mock.method(console, 'log', (...args: unknown[]) => { output.push(args); });
  let scoped = false;
  const restore = installPaymentDiagnosticFilter(() => scoped);
  try {
    console.log('[x402] extension responses: outside');
    scoped = true;
    console.log('[x402] extension responses: do not print', { private: true });
    console.log('ordinary', { detail: 1 });
    console.log('[x402] another diagnostic');
    assert.deepEqual(output, [['[x402] extension responses: outside'], ['ordinary', { detail: 1 }], ['[x402] another diagnostic']]);
  } finally { restore(); }
});
