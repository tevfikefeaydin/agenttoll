import assert from 'node:assert/strict';
import test from 'node:test';
import { buildReportCard, createReportLink, parseSharedReport } from '../web/report-share.js';
import { renderTokenReport } from '../web/token-report.js';

const token = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const ids = ['honeypot', 'taxes', 'verified', 'owner-powers', 'concentration', 'liquidity', 'creator-stake', 'deployer'];
const at = '2026-09-15T11:40:45.634Z';
function report() {
  return {
    chain: 'base', token, name: 'İstanbul 🌉 Coin', symbol: 'İST', at, holderCount: 321,
    checks: ids.map(id => ({ id, status: 'pass', complete: true, detail: 'Kanıt mevcut — 確認済み', missing: [] as string[], conflicts: [] as string[], sources: ['goplus'] })),
    sourceStatus: { goplus: { status: 'ok', fetchedAt: '2026-09-15T11:40:41.731Z', durationMs: 481 } },
    sources: ['goplus'], verdict: 'clear',
  };
}
function fragment(value: unknown) {
  return '#report=' + Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

test('share links round-trip Unicode and original observation times inside a same-site fragment', () => {
  const data = report();
  Object.assign(data.checks[5], { status: 'unknown', complete: false, missing: ['top-liquidity-provider-list'] });
  const url = new URL(createReportLink(data, 'https://agenttoll.app'));
  assert.equal(url.origin, 'https://agenttoll.app');
  assert.equal(url.pathname, '/shared-report.html');
  assert.equal(url.search, '');
  assert.match(url.hash, /^#report=[A-Za-z0-9_-]+$/);
  const decoded = parseSharedReport(url.hash);
  assert.equal(decoded.token, token);
  assert.equal(decoded.name, 'İstanbul 🌉 Coin');
  assert.equal(decoded.symbol, 'İST');
  assert.equal(decoded.at, at);
  assert.equal(decoded.sourceStatus.goplus.fetchedAt, '2026-09-15T11:40:41.731Z');
  assert.equal(decoded.checks[5].status, 'unknown');
  assert.equal(decoded.checks[5].complete, false);
  assert.deepEqual(decoded.checks[5].missing, ['top-liquidity-provider-list']);
});

test('share payloads whitelist report evidence and exclude payment, wallet and signature metadata at every level', () => {
  const data = report();
  Object.assign(data, { payer: 'secret-payer', addressWallet: 'secret-wallet', transaction: 'secret-transaction', signature: 'secret-signature', payment: { receipt: 'secret-receipt' }, provenance: 'trusted' });
  Object.assign(data.checks[0], { payer: 'secret-nested-payer', signature: 'secret-nested-signature' });
  Object.assign(data.sourceStatus.goplus, { wallet: 'secret-source-wallet', transaction: 'secret-source-transaction' });
  const url = new URL(createReportLink(data, 'https://agenttoll.app'));
  const payload = Buffer.from(url.hash.slice('#report='.length), 'base64url').toString('utf8');
  assert.doesNotMatch(payload, /secret-|payer|addressWallet|transaction|signature|payment|provenance/);
  const reportWithExtraKeys = fragment({ version: 1, report: data, payment: { payer: 'secret-envelope-payer' } });
  assert.doesNotMatch(JSON.stringify(parseSharedReport(reportWithExtraKeys)), /secret-|payer|addressWallet|transaction|signature|payment|provenance/);
});

test('shared HTML escapes sender text and does not trust supplied coverage or all-clear verdicts', () => {
  const data = report();
  data.name = '<img src=x onerror=alert(1)>';
  data.checks[0].detail = '<script>alert(1)</script>';
  Object.assign(data.checks[1], { status: 'pass', complete: false, missing: ['buy-tax'] });
  Object.assign(data, { coverage: { complete: true, completedChecks: 8 }, verdict: 'clear' });
  const clean = parseSharedReport(new URL(createReportLink(data, 'https://agenttoll.app')).hash);
  const html = renderTokenReport(clean);
  assert.match(html, /&lt;img/);
  assert.match(html, /&lt;script/);
  assert.doesNotMatch(html, /<img|<script|data-verdict="clear"/);
  assert.match(html, /7 of 8 checks complete/);
});

test('malformed, empty, truncated, invalid UTF-8 and future-version fragments fail visibly', () => {
  const good = fragment({ version: 1, report: report() });
  for (const bad of [
    '', '#', '#report=', '#report=not+base64', '#report=a', good + '&report=x', good + '=',
    '#report=' + Buffer.from('{"version":1').toString('base64url'),
    '#report=' + Buffer.from([0xff, 0xfe, 0xff]).toString('base64url'),
    fragment(null), fragment([]), fragment({ version: 1 }), fragment({ report: report() }),
    fragment({ version: 2, report: report() }), fragment({ version: '1', report: report() }),
    fragment({ version: 1, report: { ...report(), token: 'javascript:alert(1)' } }),
    fragment({ version: 1, report: { ...report(), chain: 'ethereum' } }),
  ]) assert.throws(() => parseSharedReport(bad), /shared|snapshot|report|token|address|version/i);
});

test('oversized fragments and reports are rejected instead of silently truncating a shared observation', () => {
  assert.throws(() => parseSharedReport('#report=' + 'a'.repeat(20_001)), /too large|too long|size/i);
  const data = report();
  for (const check of data.checks) {
    check.detail = '界'.repeat(2000);
    check.missing = Array.from({ length: 30 }, (_, index) => `${index}:` + '証'.repeat(100));
  }
  assert.throws(() => createReportLink(data, 'https://agenttoll.app'), /too large|too long|size/i);
});

test('share URLs reject origins that can escape HTTP navigation or embed credentials', () => {
  for (const origin of ['javascript:alert(1)', 'data:text/html,hi', '//evil.test', '/local', 'https://user:secret@agenttoll.app']) {
    assert.throws(() => createReportLink(report(), origin), /origin|address|http|URL/i);
  }
});

test('PNG card content keeps all eight named statuses, incomplete coverage and the supplied observation date', () => {
  const data = report();
  Object.assign(data.checks[0], { status: 'fail', complete: true });
  Object.assign(data.checks[5], { status: 'unknown', complete: false });
  Object.assign(data.checks[7], { status: 'warn', complete: false, missing: ['scam-flag'] });
  const card = buildReportCard(data, 'inspection');
  assert.equal(card.token, token);
  assert.equal(card.name, 'İstanbul 🌉 Coin');
  assert.equal(card.observedAt, at);
  assert.equal(card.completed, 6);
  assert.equal(card.flags, 1);
  assert.equal(card.warnings, 1);
  assert.equal(card.coverage, '6 of 8 checks complete');
  assert.deepEqual(card.checks.map(check => check.title), [
    'Buying and selling', 'Trading taxes', 'Contract source', 'Owner permissions',
    'Holder concentration', 'Liquidity ownership', 'Creator holdings', 'Who deployed it',
  ]);
  assert.equal(card.checks[0].label, 'Risk flag');
  assert.equal(card.checks[5].label, 'Not available');
  assert.equal(card.checks[5].tone, 'amber');
  assert.equal(card.checks[7].label, 'Review · incomplete');
});

test('PNG cards label shared and example provenance without upgrading missing or malformed times', () => {
  const data = report();
  const shared = buildReportCard(data, 'shared');
  assert.equal(shared.provenanceLabel, 'Shared snapshot · unverified');
  assert.equal(shared.provenanceNote, 'The sender supplied this snapshot. AgentToll has not authenticated its contents.');
  assert.equal(buildReportCard(data, 'example').provenanceLabel, 'Recorded example');
  assert.equal(buildReportCard(data, 'inspection').provenanceLabel, 'Inspection snapshot');
  assert.equal(buildReportCard({ ...data, at: null }, 'shared').observedAt, null);
  assert.equal(buildReportCard({ ...data, at: 'not-a-date' }, 'example').dateLabel, 'Time unavailable');
  assert.throws(() => buildReportCard(data, 'trusted' as 'shared'), /provenance|source/i);
});
