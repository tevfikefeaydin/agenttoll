// Local-only browser acceptance fixture. No external providers, funded wallet or settlement.
// Run from the repository root: node docs/research/growth-browser-fixture.mjs
import express from 'express';
import { readFileSync } from 'node:fs';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
const app = express();
const host = 'http://127.0.0.1:4036';
const account = privateKeyToAccount(generatePrivateKey());
const receiver = '0x1111111111111111111111111111111111111111';
const asset = '0x036cbd53842c5426634e7929541ec2318f3dcf7e';
const token = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const sample = JSON.parse(readFileSync('public/token-example.json', 'utf8'));
let signedRequests = 0;
let walletCalls = 0;
app.use(express.json({ limit: '64kb' }));
app.get('/fixture/state', (_req, res) => res.json({ signedRequests, walletCalls, mode: 'local-fixture-no-settlement' }));
app.post('/fixture/wallet', async (req, res) => {
  walletCalls++;
  const { method, params } = req.body;
  if (method === 'eth_requestAccounts') return res.json([account.address]);
  if (method === 'eth_chainId') return res.json('0x14a34');
  if (method === 'eth_getCode') return res.json('0x');
  if (method === 'eth_signTypedData_v4') {
    try {
      const data = JSON.parse(params[1]);
      // Never turn the fixture into a signing bridge for production terms.
      if (Number(data.domain?.chainId) !== 84532 || String(data.domain?.verifyingContract).toLowerCase() !== asset ||
          String(data.message?.to).toLowerCase() !== receiver || !['3000'].includes(String(data.message?.value))) {
        return res.status(400).json({ error: 'fixture terms only' });
      }
      return res.json(await account.signTypedData(data));
    } catch { return res.status(400).json({ error: 'invalid fixture signing request' }); }
  }
  return res.status(400).json({ error: 'unsupported fixture method' });
});
app.get('/.well-known/agent-card.json', (_req, res) => res.json({ url: host, identity: { payTo: receiver }, dataNetwork: 'base',
  interfaces: { http: { baseUrl: host, payment: { protocol: 'x402', version: 2, network: 'eip155:84532', asset: 'USDC' } } } }));
app.use('/api', (req, res) => {
  const path = req.originalUrl;
  if (path === '/api/health') return res.json({ ok: true, fixture: true });
  if (path === '/api/stats') return res.json({ externalPayers: 0, externalTolls: 0, partial: true });
  const radar = path === '/api/base/radar?minLiquidity=10000&limit=15';
  const safety = /^\/api\/base\/safety\/0x[0-9a-f]{40}$/.test(path);
  if (!radar && !safety) return res.status(404).json({ error: 'Fixture endpoint unavailable' });
  if (!req.headers['payment-signature']) {
    const quote = { x402Version: 2, resource: { url: host + path }, accepts: [{ scheme: 'exact', network: 'eip155:84532',
      amount: '3000', payTo: receiver, maxTimeoutSeconds: 60, asset, extra: { name: 'USDC', version: '2' } }] };
    return res.status(402).set('PAYMENT-REQUIRED', Buffer.from(JSON.stringify(quote)).toString('base64')).json(quote);
  }
  signedRequests++;
  res.set('PAYMENT-RESPONSE', Buffer.from(JSON.stringify({ success: true, transaction: '0x' + signedRequests.toString(16).padStart(64, '0'),
    network: 'eip155:84532', payer: account.address })).toString('base64'));
  const at = new Date().toISOString();
  if (radar) return res.json({ chain: 'base', at, source: 'geckoterminal-new-pools', minLiquidityUsd: 10000, count: 2,
    pools: [{ name: 'USDC / WETH', pool: '0x' + 'a'.repeat(40), token, createdAt: at, liquidityUsd: 25000, volume24hUsd: 1000, priceUsd: 1 },
      { name: '<img src=x onerror=alert(1)>', pool: '0x' + 'b'.repeat(40), token: null, createdAt: null, liquidityUsd: 12000, volume24hUsd: null, priceUsd: null }] });
  const report = structuredClone(sample.data ?? sample.report ?? sample);
  report.token = path.split('/').at(-1);
  report.at = at;
  return res.json(report);
});
app.use(express.static('public'));
app.listen(4036, '127.0.0.1', () => console.log(`Fixture only: ${host}; no external network or real settlement.`));
