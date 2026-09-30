import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeToken, sanitizeReport, summarizeReport, diffReports } from '../web/research-model.js';
import { renderTokenReport } from '../web/token-report.js';

const token = '0x' + 'a'.repeat(40);
const ids = ['honeypot', 'taxes', 'verified', 'owner-powers', 'concentration', 'liquidity', 'creator-stake', 'deployer'];
const at = '2026-09-15T10:00:00.000Z';
const later = '2026-09-15T11:00:00.000Z';
function fixture() {
  return { chain: 'base', token, name: 'Example', symbol: 'EX', at, holderCount: 12,
    sources: ['goplus'], sourceStatus: { goplus: { status: 'ok', fetchedAt: at, issues: [] } },
    checks: ids.map(id => ({ id, status: 'pass', complete: true, detail: 'Evidence checked.', missing: [] as unknown[], conflicts: [] as unknown[], sources: ['goplus'] })) };
}

test('normalizes valid token addresses and rejects malformed or zero addresses', () => {
  assert.equal(normalizeToken('  0x' + 'A'.repeat(40) + '  '), token);
  for (const value of [null, {}, 0, '0x' + '0'.repeat(40), '0x123', token + '/path']) assert.throws(() => normalizeToken(value));
  assert.throws(() => sanitizeReport({ ...fixture(), chain: 'ethereum' }));
  assert.throws(() => sanitizeReport(fixture(), '0x' + 'b'.repeat(40)));
});

test('canonical snapshots exclude payment, wallet, and unknown metadata at every retained level', () => {
  const value = fixture();
  const clean = sanitizeReport({ ...value, payer: token, receipt: { transaction: 'secret' }, signature: 'secret', requestId: 'secret',
    unknown: 'secret', checks: value.checks.map(c => ({ ...c, signature: 'secret' })),
    sourceStatus: { goplus: { ...value.sourceStatus.goplus, wallet: 'secret', signature: 'secret' } } });
  assert.equal(JSON.stringify(clean).includes('secret'), false);
  assert.equal(clean.token, token);
  assert.equal(clean.holderCount, 12);
  assert.deepEqual(sanitizeReport(clean), clean);
  assert.match(renderTokenReport(clean), /8 of 8 checks complete/);
});

test('recomputes verdict and coverage instead of trusting supplied safety claims', () => {
  const value = fixture();
  value.checks[0] = { ...value.checks[0], status: 'fail', complete: false, missing: ['cannot_buy'] };
  const summary = summarizeReport({ ...value, verdict: 'clear', coverage: { completedChecks: 8 } });
  assert.equal(summary.flags, 1);
  assert.equal(summary.completed, 7);
  assert.equal(summary.verdict, 'high-risk');
  assert.equal(summary.checks[0].status, 'fail');
  assert.equal(summary.checks[0].title, 'Buying and selling');
});

test('absent and duplicate known checks stay unassessed', () => {
  const value = fixture();
  const summary = summarizeReport({ ...value, checks: [value.checks[0], value.checks[0]] });
  assert.equal(summary.checks.length, 8);
  assert.equal(summary.completed, 0);
  assert.equal(summary.checks[0].status, 'unknown');
  assert.equal(summary.checks[1].status, 'unknown');
  assert.equal(summary.verdict, 'insufficient-data');
});

test('missing and conflicting evidence cannot remain a complete pass', () => {
  const value = fixture();
  value.checks[0].missing = ['cannot_buy'];
  value.checks[1].conflicts = ['buy-tax'];
  const summary = summarizeReport(value);
  assert.equal(summary.checks[0].status, 'unknown');
  assert.equal(summary.checks[1].status, 'warn');
  assert.equal(summary.completed, 6);
  assert.equal(summary.warnings, 1);
});

test('malformed status and evidence arrays do not coerce into a pass', () => {
  const value = fixture();
  const cases = [{ status: { toString: () => 'pass' } }, { missing: [null] }, { conflicts: {} }, { sources: [42] }];
  for (const fields of cases) {
    const summary = summarizeReport({ ...value, checks: [{ ...value.checks[0], ...fields }] });
    assert.equal(summary.checks[0].complete, false);
    assert.equal(summary.checks[0].status, 'unknown');
  }
});

test('bounds retained strings and evidence while preserving incomplete coverage', () => {
  const value = fixture();
  const summary = summarizeReport({ ...value, name: 'N'.repeat(100_000), symbol: 'S'.repeat(100_000),
    checks: [{ ...value.checks[0], detail: 'D'.repeat(100_000), missing: Array.from({ length: 500 }, (_, i) => 'missing-' + i) }] });
  assert.ok(summary.name.length <= 200);
  assert.ok(summary.symbol.length <= 80);
  assert.ok(summary.checks[0].detail.length <= 2000);
  assert.ok(summary.checks[0].missing.length <= 32);
  assert.equal(summary.checks[0].complete, false);
  assert.throws(() => sanitizeReport({ ...value, checks: Array.from({ length: 100_000 }, () => value.checks[0]) }), /too many|large/i);
});

test('sanitizing malformed bounded evidence twice does not change its saved meaning', () => {
  const value = fixture();
  const clean = sanitizeReport({ ...value,
    checks: [{ ...value.checks[0], missing: Array.from({ length: 30 }, (_, i) => 'missing-' + i), sources: [42] }],
    sourceStatus: { goplus: { status: 'ok', fetchedAt: at, issues: Array.from({ length: 100 }, (_, i) => 'issue-' + i) } } });
  assert.deepEqual(sanitizeReport(clean), clean);
  assert.equal(summarizeReport(clean).completed, 0);
});

test('valid ISO dates normalize to UTC and invalid or timezone-free dates remain explicit', () => {
  assert.equal(summarizeReport({ ...fixture(), at: '2026-09-15T13:00:00+03:00' }).at, at);
  for (const date of [undefined, null, 'yesterday', '2026-09-15', '2026-09-15T10:00:00', '2026-02-30T10:00:00Z', {}, 1]) {
    assert.equal(summarizeReport({ ...fixture(), at: date }).at, null);
  }
});

test('untrusted names stay plain text for the renderer to escape', () => {
  const clean = sanitizeReport({ ...fixture(), name: '<img src=x onerror=alert(1)>' });
  assert.equal(clean.name, '<img src=x onerror=alert(1)>');
  assert.equal(renderTokenReport(clean).includes('<img src=x'), false);
});

test('changes include detail and missing evidence without making safety claims', () => {
  const before = fixture();
  const after = fixture();
  after.at = later;
  after.checks[0].detail = 'Source unavailable.';
  after.checks[0].missing = ['cannot_buy'];
  const diff = diffReports(before, after);
  assert.equal(diff.comparable, true);
  assert.equal(diff.sameObservation, false);
  assert.equal(diff.changes.length, 1);
  assert.equal(diff.changes[0].id, 'honeypot');
  assert.equal(diff.changes[0].evidenceLost, true);
  assert.ok(diff.changes[0].fields.includes('detail'));
  assert.ok(diff.changes[0].fields.includes('missing'));
  assert.equal(diff.changes[0].after.status, 'unknown');
});

test('a partially assessed risk disappearing is still lost evidence', () => {
  const before = fixture();
  before.checks[0] = { ...before.checks[0], status: 'fail', complete: false, sources: [], missing: ['simulation'] };
  const after = fixture();
  after.at = later;
  after.checks = after.checks.filter(check => check.id !== 'honeypot');
  const diff = diffReports(before, after);
  assert.equal(diff.changes[0].before.status, 'fail');
  assert.equal(diff.changes[0].after.status, 'unknown');
  assert.equal(diff.changes[0].evidenceLost, true);
});

test('timestamp-only changes and evidence list ordering do not create changed checks', () => {
  const before = fixture();
  before.checks[0].sources = ['goplus', 'honeypot.is'];
  const after = fixture();
  after.at = later;
  after.sourceStatus.goplus.fetchedAt = later;
  after.checks[0].sources = ['honeypot.is', 'goplus', 'goplus'];
  const diff = diffReports(before, after);
  assert.equal(diff.comparable, true);
  assert.deepEqual(diff.changes, []);
});

test('same dated observation with different content is a conflict, not a fresh check', () => {
  const before = fixture();
  const after = fixture();
  after.checks[0].detail = 'Unexpected changed payload.';
  const diff = diffReports(before, after);
  assert.equal(diff.sameObservation, true);
  assert.equal(diff.comparable, false);
  assert.deepEqual(diff.changes, []);
  assert.match(diff.warnings.join(' '), /same.*observation.*different|conflict/i);
});

test('identical cached observation is labeled and undated/reversed observations cannot imply change over time', () => {
  const repeated = diffReports(fixture(), fixture());
  assert.equal(repeated.sameObservation, true);
  assert.equal(repeated.comparable, false);
  assert.deepEqual(repeated.changes, []);
  for (const [before, after] of [[{ ...fixture(), at: null }, fixture()], [{ ...fixture(), at: later }, fixture()]]) {
    const diff = diffReports(before, after);
    assert.equal(diff.comparable, false);
    assert.deepEqual(diff.changes, []);
    assert.ok(diff.warnings.length > 0);
  }
  assert.throws(() => diffReports(fixture(), { ...fixture(), token: '0x' + 'b'.repeat(40) }));
});
