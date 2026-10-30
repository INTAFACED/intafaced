/**
 * Unit tests for the LOCAL TEST outside source. Temp folders only: no stack.
 * Run: node --test tooling/scripts/local-test-outside-source.test.mjs
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { answerOutside, serveOutsideSource } from './local-test-outside-source.mjs';
import { RECORDS_DIR, recordRailMovement } from './local-test-rail-records.mjs';

const fresh = () => mkdtempSync(path.join(tmpdir(), 'outside-source-'));
const at = '2026-10-29T10:00:00.000Z';

test("serves the whole book and one rail from the rails' own records", () => {
  const dir = fresh();
  recordRailMovement(dir, { rail: 'crypto-native', key: 'd1', direction: 'in', assetId: 'ETH', amount: '1', at });
  recordRailMovement(dir, { rail: 'payout-sim', key: 'p1', direction: 'out', assetId: 'ETH', amount: '0.25', at });
  const snapshot = answerOutside(dir, 'GET', '/snapshot?asOf=2026-10-29T11:00:00Z');
  assert.deepEqual(snapshot, {
    status: 200,
    body: { source: 'rail', asOf: '2026-10-29T11:00:00.000Z', balances: [{ assetId: 'ETH', amount: '-0.75' }] },
  });
  const statement = answerOutside(dir, 'GET', '/statement?rail=payout-sim&asOf=2026-10-29T11:00:00Z');
  assert.deepEqual(statement.body, {
    source: 'rail',
    rail: 'payout-sim',
    asOf: '2026-10-29T11:00:00.000Z',
    balances: [{ assetId: 'ETH', amount: '0.25' }],
  });
});

test('a bad query, the mint or a broken record answers with no figures', () => {
  const dir = fresh();
  assert.equal(answerOutside(dir, 'GET', '/snapshot').status, 400);
  assert.equal(answerOutside(dir, 'GET', '/statement?rail=local-test&asOf=2026-10-29T11:00:00Z').status, 400);
  assert.equal(answerOutside(dir, 'POST', '/snapshot?asOf=2026-10-29T11:00:00Z').status, 405);
  assert.equal(answerOutside(dir, 'GET', '/elsewhere').status, 404);
  mkdirSync(path.join(dir, RECORDS_DIR));
  writeFileSync(path.join(dir, RECORDS_DIR, 'crypto-native.jsonl'), '{"label":"REAL"}\n');
  const broken = answerOutside(dir, 'GET', '/snapshot?asOf=2026-10-29T11:00:00Z');
  assert.equal(broken.status, 400);
  assert.equal('balances' in broken.body, false);
});

test('answers over HTTP on loopback and refuses a foreign Host header', async () => {
  const dir = fresh();
  const server = serveOutsideSource({ host: '127.0.0.1', port: 0, stateDir: dir });
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  const get = (host) =>
    new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/health', headers: { host } }, (res) => resolve(res.statusCode)).on('error', reject);
    });
  try {
    assert.equal(await get(`127.0.0.1:${port}`), 200);
    assert.equal(await get(`localhost:${port}`), 200);
    assert.equal(await get('evil.example'), 403);
  } finally {
    server.close();
  }
});
