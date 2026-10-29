import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { recordRailMovement } from './local-test-rail-records.mjs';
import { STATEMENT_RAILS, answerStatement, railStatementEnv, serveRailStatements } from './local-test-rail-statements.mjs';

const fresh = () => mkdtempSync(path.join(tmpdir(), 'rail-statements-'));

test('a rail statement is that rail alone, from its own records, signed for its boundary, at the instant asked', () => {
  const state = fresh();
  recordRailMovement(state, {
    rail: 'crypto-native',
    key: 'd1',
    direction: 'in',
    assetId: 'USDT',
    amount: '300',
    at: '2026-10-29T10:00:00.000Z',
  });
  recordRailMovement(state, {
    rail: 'crypto-native',
    key: 'w1',
    direction: 'out',
    assetId: 'USDT',
    amount: '25',
    at: '2026-10-29T11:00:00.000Z',
  });
  recordRailMovement(state, {
    rail: 'payout-sim',
    key: 'p1',
    direction: 'out',
    assetId: 'USDT',
    amount: '20',
    at: '2026-10-29T10:30:00.000Z',
  });
  const [status, body] = answerStatement(state, 'GET', '/statement?rail=crypto-native&asOf=2026-10-29T12:00:00.000Z');
  assert.equal(status, 200);
  assert.deepEqual(body, {
    source: 'rail',
    rail: 'crypto-native',
    asOf: '2026-10-29T12:00:00.000Z',
    balances: [{ assetId: 'USDT', amount: '-275' }],
  });
  // A movement after asOf is not yet on the statement.
  assert.deepEqual(answerStatement(state, 'GET', '/statement?rail=crypto-native&asOf=2026-10-29T10:30:00.000Z')[1].balances, [
    { assetId: 'USDT', amount: '-300' },
  ]);
  assert.deepEqual(answerStatement(state, 'GET', '/statement?rail=payout-sim&asOf=2026-10-29T12:00:00.000Z')[1].balances, [
    { assetId: 'USDT', amount: '20' },
  ]);
  // A rail with no records yet says it holds nothing.
  assert.deepEqual(answerStatement(fresh(), 'GET', '/statement?rail=payout-sim&asOf=2026-10-29T12:00:00.000Z')[1].balances, []);
});

test('the TEST mint and unknown rails have no statement; a bad query or unreadable records never answer a balance', () => {
  const state = fresh();
  assert.equal(answerStatement(state, 'GET', '/statement?rail=local-test&asOf=2026-10-29T12:00:00Z')[0], 404);
  assert.equal(answerStatement(state, 'GET', '/statement?rail=card-sim&asOf=2026-10-29T12:00:00Z')[0], 404);
  assert.equal(answerStatement(state, 'GET', '/statement?rail=crypto-native')[0], 400);
  assert.equal(answerStatement(state, 'GET', '/statement?rail=crypto-native&asOf=yesterday')[0], 400);
  assert.equal(answerStatement(state, 'POST', '/statement?rail=crypto-native&asOf=2026-10-29T12:00:00Z')[0], 405);
  assert.equal(answerStatement(state, 'GET', '/other')[0], 404);
  recordRailMovement(state, { rail: 'crypto-native', key: 'd1', direction: 'in', assetId: 'USDT', amount: '1' });
  appendFileSync(path.join(state, 'test-rail-records', 'crypto-native.jsonl'), '{"label":"TEST","rail":"crypto-native"}\n');
  const [status, body] = answerStatement(state, 'GET', '/statement?rail=crypto-native&asOf=2099-01-01T00:00:00Z');
  assert.equal(status, 503);
  assert.match(body.error, /crypto-native/);
});

test('the served rails and their env names are the ones svc-ledger reads', async () => {
  assert.deepEqual(STATEMENT_RAILS, ['crypto-native', 'payout-sim']);
  assert.equal(railStatementEnv('crypto-native'), 'LEDGER_RECONCILE_RAIL_CRYPTO_NATIVE_URL');
  assert.equal(railStatementEnv('payout-sim'), 'LEDGER_RECONCILE_RAIL_PAYOUT_SIM_URL');
  const state = fresh();
  recordRailMovement(state, {
    rail: 'payout-sim',
    key: 'p1',
    direction: 'in',
    assetId: 'USDT',
    amount: '5',
    at: '2026-10-29T10:00:00.000Z',
  });
  const server = serveRailStatements({ host: '127.0.0.1', port: 0, stateDir: state });
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const res = await fetch(`${base}/statement?rail=payout-sim&asOf=2026-10-29T12:00:00.000Z`);
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).balances, [{ assetId: 'USDT', amount: '-5' }]);
    assert.equal((await fetch(`${base}/health`)).status, 200);
  } finally {
    server.close();
  }
});
