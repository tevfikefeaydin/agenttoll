import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeRequests } from '../src/operations-report.js';

const row = (id: string, extra: Record<string, unknown> = {}) => JSON.stringify({
  schemaVersion: 1, t: '2026-09-12T00:00:00Z', requestId: id, method: 'GET',
  path: '/api/gas', status: 402, ms: 10, paymentStage: 'quote', paymentSubmitted: false,
  upstreamCalls: 0, cacheHits: 0, cacheMisses: 0, coalescedLoads: 0, ...extra,
});

test('operations report deduplicates requests and separates quotes, declines, unknowns and settlement', () => {
  const report = summarizeRequests([
    row('a'), row('a'),
    row('b', { status: 200, ms: 20, paymentStage: 'settled', paymentSubmitted: true, upstreamCalls: 2, cacheMisses: 1 }),
    row('c', { paymentStage: 'rejected', paymentSubmitted: true, ms: 30 }),
    row('d', { status: 504, paymentStage: 'unknown', paymentSubmitted: true, ms: 100, errorCode: 'REQUEST_TIMEOUT' }),
    row('e', { schemaVersion: undefined, paymentStage: 'settled', status: 402, ms: 40 }),
    'not json', '{}',
  ].join('\n'));
  assert.equal(report.requests, 5);
  assert.equal(report.duplicates, 1);
  assert.equal(report.ignoredLines, 2);
  assert.equal(report.serverErrors, 1);
  assert.equal(report.serverErrorRate, 0.2);
  assert.deepEqual(report.payment, { quotes: 1, submitted: 3, settled: 1, rejected: 1, unknown: 1, legacyUnclassified: 1 });
  assert.equal(report.latencyMs.p50, 30);
  assert.equal(report.latencyMs.p95, 100);
  assert.equal(report.upstreamCalls, 2);
  assert.equal(report.routes[0].requests, 5);
  assert.equal('conversionRate' in report, false);
});

test('operations reports redact dynamic paths and preserve the supplied observation window', () => {
  const report = summarizeRequests([
    row('a', { path: '/API/base/token/0x2222222222222222222222222222222222222222/?secret=test' }),
    row('b', { t: '2026-09-12T01:00:00Z', path: '/api/base/token/0x3333333333333333333333333333333333333333' }),
    row('c', { path: '/api/not-a-route/private-data' }),
  ].join('\n'));
  assert.equal(report.window.firstRequestAt, '2026-09-12T00:00:00.000Z');
  assert.equal(report.window.lastRequestAt, '2026-09-12T01:00:00.000Z');
  assert.equal(report.routes.find(r => r.route === '/api/base/token/{address}')?.requests, 2);
  assert.doesNotMatch(JSON.stringify(report), /222222|333333|secret|private-data/);
});

test('malformed timestamps, counters and impossible payment states do not fabricate success', () => {
  const report = summarizeRequests([
    row('bad-time', { t: 'banana' }), row('bad-status', { status: 999 }), row('bad-ms', { ms: -1 }),
    row('bad-settlement', { status: 502, paymentStage: 'settled', paymentSubmitted: true }),
    row('unsigned-settlement', { status: 200, paymentStage: 'settled', paymentSubmitted: false }),
    row('negative-counter', { upstreamCalls: -5 }),
  ].join('\n'));
  assert.equal(report.payment.settled, 0);
  assert.equal(report.ignoredLines, 6);
  assert.equal(report.requests, 0);
  assert.equal(report.serverErrorRate, null);
  assert.equal(report.latencyMs.p95, null);
});
