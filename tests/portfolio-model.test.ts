import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePortfolio } from '../web/portfolio-model.js';

const WALLET = '0x1111111111111111111111111111111111111111';
const TOKEN = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const AT = '2026-09-15T08:00:00.000Z';
function holding(address = TOKEN) {
  return { address, symbol: 'TEST', name: 'Test token', balance: 2, priceUsd: 3.5, valueUsd: 7 };
}
function portfolio(changes: Record<string, unknown> = {}) {
  return { chain: 'base', address: WALLET, basename: null,
    native: { symbol: 'ETH', balance: 1, priceUsd: 2000, valueUsd: 2000 },
    tokens: [holding()], totalUsd: 2007, tokenCount: 1, shown: 1, hiddenBelowFloor: 0,
    unpriced: 0, minValueUsd: 0, source: 'blockscout', at: AT, ...changes };
}

test('portfolio keeps source timestamps and the reported total including native ETH', () => {
  const summary = parsePortfolio(portfolio(), WALLET);
  assert.equal(summary.address, WALLET);
  assert.equal(summary.at, AT);
  assert.equal(summary.totalUsd, 2007);
  assert.equal(summary.tokens[0].valueUsd, 7);
  assert.equal(summary.source, 'blockscout');
  assert.equal(summary.tokenCount, 1);
  assert.equal(summary.shown, 1);
});

test('degraded, unpriced, below-floor and truncated holdings remain explicit gaps', () => {
  const summary = parsePortfolio(portfolio({ partial: true, note: 'Major Base tokens only.',
    source: 'multicall3+defillama', tokenCount: 5, unpriced: 4, hiddenBelowFloor: 8, minValueUsd: 1 }), WALLET);
  assert.equal(summary.partial, true);
  assert.match(summary.note ?? '', /Major Base tokens only/);
  assert.equal(summary.tokenCount, 5);
  assert.equal(summary.shown, 1);
  assert.equal(summary.unpriced, 4);
  assert.equal(summary.hiddenBelowFloor, 8);
  assert.equal(summary.minValueUsd, 1);
  assert.match(summary.note ?? '', /truncat|listed|shown/i);
});

test('missing numbers and coverage metadata remain unknown, never zero', () => {
  const summary = parsePortfolio({ chain: 'base', address: WALLET, at: AT,
    tokens: [{ address: TOKEN, symbol: 'TEST', name: 'Test', balance: null }] }, WALLET);
  assert.equal(summary.tokens[0].balance, null);
  assert.equal(summary.tokens[0].priceUsd, null);
  assert.equal(summary.tokens[0].valueUsd, null);
  assert.equal(summary.tokenCount, null);
  assert.equal(summary.shown, null);
  assert.equal(summary.unpriced, null);
  assert.equal(summary.hiddenBelowFloor, null);
  assert.equal(summary.minValueUsd, null);
  assert.equal(summary.totalUsd, null);
  assert.equal(summary.source, null);
  assert.equal(summary.partial, true);
  assert.match(summary.note ?? '', /unknown|unavailable|missing/i);
});

test('duplicate ERC20 rows cannot appear as distinct holdings or scan candidates', () => {
  const summary = parsePortfolio(portfolio({ tokens: [holding(), holding('0x' + 'A'.repeat(40))], shown: 2, tokenCount: 2 }), WALLET);
  assert.equal(summary.tokens.length, 1);
  assert.equal(summary.tokens[0].address, TOKEN);
  assert.equal(summary.tokenCount, 2, 'Retain the source count instead of silently rewriting it');
  assert.equal(summary.partial, true);
  assert.match(summary.note ?? '', /duplicate/i);
});

test('portfolio displays at most fifty ERC20 holdings and identifies the omitted rows', () => {
  const tokens = Array.from({ length: 51 }, (_, i) => holding('0x' + (i + 1).toString(16).padStart(40, '0')));
  const summary = parsePortfolio(portfolio({ tokens, tokenCount: 51, shown: 51 }), WALLET);
  assert.equal(summary.tokens.length, 50);
  assert.equal(summary.shown, 51);
  assert.equal(summary.partial, true);
  assert.match(summary.note ?? '', /50|omitted|display/i);
});

for (const [name, changes] of [
  ['wrong wallet', { address: TOKEN }], ['wrong network', { chain: 'ethereum' }],
  ['invalid token address', { tokens: [holding('not-an-address')] }],
  ['native placeholder', { tokens: [holding('0x' + '0'.repeat(40))] }],
  ['negative money', { totalUsd: -1 }], ['non-finite money', { totalUsd: Infinity }],
  ['string money', { totalUsd: '2007' }], ['invalid timestamp', { at: 'yesterday' }],
  ['invalid calendar day', { at: '2026-02-30T08:00:00.000Z' }],
  ['impossible counts', { tokenCount: 0 }], ['fractional count', { unpriced: 0.5 }],
  ['not an array', { tokens: {} }], ['non-boolean partial', { partial: 'false' }],
  ['malformed native value after a missing balance', { native: { balance: null, priceUsd: Infinity, valueUsd: 0 } }],
] as const) {
  test(`portfolio rejects ${name}`, () => { assert.throws(() => parsePortfolio(portfolio(changes), WALLET)); });
}

test('untrusted portfolio labels are bounded without interpreting HTML', () => {
  const summary = parsePortfolio(portfolio({ tokens: [{ ...holding(), symbol: '<script>' + 'x'.repeat(1000), name: 'n'.repeat(5000) }],
    source: 's'.repeat(5000), note: 'p'.repeat(5000) }), WALLET);
  assert.ok(summary.tokens[0].symbol.length <= 64);
  assert.ok(summary.tokens[0].name.length <= 160);
  assert.ok((summary.source?.length ?? 0) <= 120);
  assert.ok((summary.note?.length ?? 0) <= 2500);
  assert.match(summary.tokens[0].symbol, /^<script>/);
});
