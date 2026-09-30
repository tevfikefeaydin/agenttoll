import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectionEndpoint, renderTokenReport, displayUsdc } from '../web/token-report.js';

const token = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const ids = ['honeypot', 'taxes', 'verified', 'owner-powers', 'concentration', 'liquidity', 'creator-stake', 'deployer'];
function report() {
  return { chain: 'base', token, name: 'USD Coin', symbol: 'USDC', at: '2026-09-15T12:00:00.000Z',
    verdict: 'clear', holderCount: null,
    checks: ids.map(id => ({ id, status: 'pass', complete: true, detail: 'Evidence available', sources: ['goplus'], missing: [], conflicts: [] })),
    coverage: { complete: true, completedChecks: 8, totalChecks: 8 }, sources: ['goplus'] };
}

test('inspection accepts a pasted Base token address and rejects malformed or zero addresses', () => {
  assert.equal(inspectionEndpoint('  0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913  '), '/api/base/safety/' + token);
  for (const invalid of ['', 'eth', '0x123', 'https://evil.test/token', '0x' + '0'.repeat(40), token + '?x=1']) {
    assert.throws(() => inspectionEndpoint(invalid));
  }
});

test('missing liquidity evidence remains incomplete even if the top-level verdict says clear', () => {
  const data = report();
  Object.assign(data.checks.find(c => c.id === 'liquidity')!, { status: 'unknown', complete: false, detail: 'Liquidity ownership unavailable', missing: ['top-liquidity-provider-list'] });
  const html = renderTokenReport(data, token);
  assert.match(html, /data-verdict="insufficient-data"/);
  assert.match(html, /7 of 8 checks complete/);
  assert.match(html, /Liquidity ownership unavailable/);
  assert.doesNotMatch(html, /undefined|null holders|0 holders/);
});

test('a detected risk remains prominent alongside missing evidence', () => {
  const data = report();
  Object.assign(data.checks[0], { status: 'fail', complete: false, detail: 'Static analysis reports a sell restriction', missing: ['simulation'] });
  const html = renderTokenReport(data, token);
  assert.match(html, /data-verdict="high-risk"/);
  assert.match(html, /Static analysis reports a sell restriction/);
  assert.match(html, /simulation/);
});

test('missing checks cannot produce an all-clear report', () => {
  const data = report(); data.checks = [];
  const html = renderTokenReport(data, token);
  assert.match(html, /data-verdict="insufficient-data"/);
  assert.match(html, /0 of 8 checks complete/);
});

test('token and provider text is escaped before rendering', () => {
  const data = report();
  data.name = '<img src=x onerror=alert(1)>';
  data.checks[0].detail = '<script>alert(1)</script>';
  data.checks[0].sources = ['javascript:alert(1)'];
  const html = renderTokenReport(data, token);
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /<img|<script|href="javascript:/);
});

test('a response for another token or network cannot replace the requested report', () => {
  assert.throws(() => renderTokenReport(report(), '0x' + '1'.repeat(40)));
  assert.throws(() => renderTokenReport({ ...report(), chain: 'ethereum' }, token));
});

test('displayed prices remove only insignificant zeroes and preserve micro-USDC precision', () => {
  assert.equal(displayUsdc('0.003000'), '0.003');
  assert.equal(displayUsdc('0.000001'), '0.000001');
  assert.equal(displayUsdc('10.000000'), '10');
  assert.equal(displayUsdc('0.000000'), '0');
});

test('missing evidence is explained without exposing provider field names', () => {
  const data = report();
  Object.assign(data.checks[3], { complete: false, status: 'unknown', missing: ['is_mintable', 'owner_change_balance'] });
  Object.assign(data.checks[5], { complete: false, status: 'unknown', missing: ['top-liquidity-provider-list', 'lp_holders[0].is_locked'] });
  const html = renderTokenReport(data, token);
  assert.match(html, /minting permissions/);
  assert.match(html, /ability to change holder balances/);
  assert.match(html, /largest liquidity providers/);
  assert.match(html, /liquidity provider 1: lock status/);
  assert.doesNotMatch(html, /is_mintable|owner_change_balance|lp_holders/);
});
