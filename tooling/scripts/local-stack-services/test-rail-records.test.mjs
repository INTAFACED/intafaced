/**
 * Unit tests for the LOCAL TEST rail records. Temp folders only: no stack.
 * Run: node --test tooling/scripts/local-stack-services/test-rail-records.test.mjs
 */
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { RECORDS_DIR, RailRecordError, readRailRecords, recordRailMovement, railTotals } from './test-rail-records.mjs';

const fresh = () => mkdtempSync(path.join(tmpdir(), 'rail-records-'));
const move = (over = {}) => ({ rail: 'crypto-native', key: 'k1', direction: 'in', assetId: 'USDT', amount: '300', ...over });

test('no records folder reads as no records and no totals', () => {
  const dir = fresh();
  assert.deepEqual(readRailRecords(dir), []);
  assert.deepEqual(railTotals(dir), []);
});

test('each line is labelled TEST, lives in its rail file and is private to the stack user', () => {
  const dir = fresh();
  recordRailMovement(dir, move({ at: '2026-10-29T10:00:00.000Z' }));
  const file = path.join(dir, RECORDS_DIR, 'crypto-native.jsonl');
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {
    label: 'TEST',
    rail: 'crypto-native',
    key: 'k1',
    direction: 'in',
    assetId: 'USDT',
    amount: '300',
    at: '2026-10-29T10:00:00.000Z',
  });
  assert.equal(statSync(file).mode & 0o077, 0);
});

test('totals are per rail and asset in the ledger signed form for its boundary: in is negative, out is positive', () => {
  const dir = fresh();
  recordRailMovement(dir, move({ key: 'd1', amount: '300' }));
  recordRailMovement(dir, move({ key: 'd2', amount: '0.25' }));
  recordRailMovement(dir, move({ key: 'w1', direction: 'out', amount: '20.5' }));
  recordRailMovement(dir, move({ rail: 'payout-sim', key: 'p1', direction: 'out', amount: '20' }));
  recordRailMovement(dir, move({ key: 'b1', assetId: 'BTC', amount: '0.00000132' }));
  assert.deepEqual(railTotals(dir), [
    { rail: 'crypto-native', assetId: 'BTC', amount: '-0.00000132' },
    { rail: 'crypto-native', assetId: 'USDT', amount: '-279.75' },
    { rail: 'payout-sim', assetId: 'USDT', amount: '20' },
  ]);
});

test('the ledger scale holds: 18 decimals is the smallest amount a rail can record', () => {
  const dir = fresh();
  recordRailMovement(dir, move({ key: 'tiny', amount: '0.000000000000000001' }));
  recordRailMovement(dir, move({ key: 'big', direction: 'out', amount: '123456789012345678901234567890' }));
  assert.deepEqual(railTotals(dir), [
    { rail: 'crypto-native', assetId: 'USDT', amount: '123456789012345678901234567889.999999999999999999' },
  ]);
});

test('a total that nets to zero reads 0, never -0', () => {
  const dir = fresh();
  recordRailMovement(dir, move({ key: 'd1', amount: '1.50' }));
  recordRailMovement(dir, move({ key: 'w1', direction: 'out', amount: '1.5' }));
  assert.deepEqual(railTotals(dir), [{ rail: 'crypto-native', assetId: 'USDT', amount: '0' }]);
});

test('a retried movement writes nothing new; the same key with other facts refuses and writes nothing', () => {
  const dir = fresh();
  recordRailMovement(dir, move({ amount: '300' }));
  const again = recordRailMovement(dir, move({ amount: '300.000', at: new Date(Date.now() + 1000).toISOString() }));
  assert.equal(again.amount, '300');
  assert.equal(readRailRecords(dir).length, 1);
  assert.throws(
    () => recordRailMovement(dir, move({ amount: '301' })),
    (err) => err instanceof RailRecordError && /already recorded as "in USDT 300", not "in USDT 301"/.test(err.message),
  );
  assert.throws(() => recordRailMovement(dir, move({ direction: 'out' })), RailRecordError);
  assert.equal(readRailRecords(dir).length, 1);
  assert.deepEqual(railTotals(dir), [{ rail: 'crypto-native', assetId: 'USDT', amount: '-300' }]);
});

test('two lines that contradict each other on disk refuse the read', () => {
  const dir = fresh();
  recordRailMovement(dir, move());
  appendFileSync(
    path.join(dir, RECORDS_DIR, 'crypto-native.jsonl'),
    `${JSON.stringify({ label: 'TEST', ...move({ amount: '301' }), at: new Date().toISOString() })}\n`,
  );
  assert.throws(() => railTotals(dir), /recorded as both "in USDT 300" and "in USDT 301"/);
});

test('a line torn by a crash is not a record, and the next write on that rail cuts it off', () => {
  const dir = fresh();
  recordRailMovement(dir, move({ key: 'whole' }));
  const file = path.join(dir, RECORDS_DIR, 'crypto-native.jsonl');
  appendFileSync(file, '{"label":"TEST","rail":"crypto-na');
  assert.deepEqual(railTotals(dir), [{ rail: 'crypto-native', assetId: 'USDT', amount: '-300' }]);
  recordRailMovement(dir, move({ key: 'retried', amount: '5' }));
  assert.deepEqual(
    readFileSync(file, 'utf8')
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line).key),
    ['whole', 'retried'],
  );
  assert.deepEqual(railTotals(dir), [{ rail: 'crypto-native', assetId: 'USDT', amount: '-305' }]);
});

test('per rail, a gap on one rail is not hidden by an opposite gap on another', () => {
  const dir = fresh();
  recordRailMovement(dir, move({ key: 'd1', amount: '300' }));
  recordRailMovement(dir, move({ rail: 'payout-sim', key: 'p1', direction: 'out', amount: '300' }));
  assert.deepEqual(railTotals(dir), [
    { rail: 'crypto-native', assetId: 'USDT', amount: '-300' },
    { rail: 'payout-sim', assetId: 'USDT', amount: '300' },
  ]);
});

test('one key on two rails is two movements', () => {
  const dir = fresh();
  recordRailMovement(dir, move());
  recordRailMovement(dir, move({ rail: 'payout-sim' }));
  assert.deepEqual(railTotals(dir), [
    { rail: 'crypto-native', assetId: 'USDT', amount: '-300' },
    { rail: 'payout-sim', assetId: 'USDT', amount: '-300' },
  ]);
});

test('asOf leaves out movements the rail made later', () => {
  const dir = fresh();
  recordRailMovement(dir, move({ key: 'early', at: '2026-10-29T10:00:00.000Z' }));
  recordRailMovement(dir, move({ key: 'late', at: '2026-10-29T12:00:00.000Z' }));
  assert.deepEqual(railTotals(dir, '2026-10-29T11:00:00.000Z'), [{ rail: 'crypto-native', assetId: 'USDT', amount: '-300' }]);
  assert.throws(() => railTotals(dir, 'yesterday'), RailRecordError);
});

test('the stack TEST mint has no outside party, so it has no records', () => {
  assert.throws(() => recordRailMovement(fresh(), move({ rail: 'local-test' })), /TEST mint and has no outside records/);
});

test('a malformed movement refuses and writes nothing', () => {
  const dir = fresh();
  for (const bad of [
    { rail: 'Crypto Native' },
    { rail: 'local-test' },
    { key: '' },
    { direction: 'sideways' },
    { assetId: 'usdt' },
    { amount: 300 },
    { amount: '-1' },
    { amount: '0' },
    { amount: '1e3' },
    { amount: '0.0000000000000000001' },
    { amount: '0.000000000000000000' },
    { key: 'k'.repeat(513) },
    { at: 'soon' },
  ]) {
    assert.throws(() => recordRailMovement(dir, move(bad)), RailRecordError, JSON.stringify(bad));
  }
  assert.throws(() => recordRailMovement('', move()), RailRecordError);
  assert.deepEqual(readRailRecords(dir), []);
});

test('a line that is not a TEST record, or sits in another rail file, refuses the whole read', () => {
  const dir = fresh();
  recordRailMovement(dir, move());
  const file = path.join(dir, RECORDS_DIR, 'crypto-native.jsonl');
  appendFileSync(file, `${JSON.stringify({ ...move({ key: 'k2' }), label: 'LIVE', at: new Date().toISOString() })}\n`);
  assert.throws(() => railTotals(dir), /not labelled TEST/);

  const other = fresh();
  recordRailMovement(other, move());
  appendFileSync(
    path.join(other, RECORDS_DIR, 'crypto-native.jsonl'),
    `${JSON.stringify({ label: 'TEST', ...move({ rail: 'payout-sim', key: 'k3' }), at: new Date().toISOString() })}\n`,
  );
  assert.throws(() => railTotals(other), /names rail payout-sim/);

  const broken = fresh();
  recordRailMovement(broken, move());
  appendFileSync(path.join(broken, RECORDS_DIR, 'crypto-native.jsonl'), '{not json\n');
  assert.throws(() => railTotals(broken), /is not JSON/);
});
