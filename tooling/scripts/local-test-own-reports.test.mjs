import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OwnReportError, ownReport, recordOwnReport } from './local-test-own-reports.mjs';
import { answerStatement } from './local-test-rail-statements.mjs';

const fresh = () => mkdtempSync(path.join(tmpdir(), 'own-reports-'));
const q = (reporter, place, asOf) => `/report?reporter=${reporter}&place=${place}&asOf=${asOf}`;

test('a report is that reporter and place alone, from its own lines, as of its latest line by the instant asked', () => {
  const state = fresh();
  recordOwnReport(state, { reporter: 'venue', place: 'v1', key: 'f1', assetId: 'USDC', amount: '-5', at: '2026-11-24T10:00:00.000Z' });
  recordOwnReport(state, { reporter: 'venue', place: 'v1', key: 'f2', assetId: 'USDC', amount: '-2.5', at: '2026-11-24T11:00:00.000Z' });
  recordOwnReport(state, { reporter: 'venue', place: 'v2', key: 'f3', assetId: 'USDC', amount: '-9', at: '2026-11-24T10:00:00.000Z' });
  recordOwnReport(state, { reporter: 'partner', place: 'v1', key: 'p1', assetId: 'USDC', amount: '-1', at: '2026-11-24T10:00:00.000Z' });
  const [status, body] = answerStatement(state, 'GET', q('venue', 'v1', '2026-11-24T12:00:00.000Z'));
  assert.equal(status, 200);
  assert.deepEqual(body, {
    source: 'report',
    reporter: 'venue',
    place: 'v1',
    asOf: '2026-11-24T11:00:00.000Z',
    balances: [{ assetId: 'USDC', amount: '-7.5' }],
  });
  // Between the two lines: the first report only, with its own as-of.
  assert.deepEqual(ownReport(state, 'venue', 'v1', '2026-11-24T10:30:00.000Z'), {
    source: 'report',
    reporter: 'venue',
    place: 'v1',
    asOf: '2026-11-24T10:00:00.000Z',
    balances: [{ assetId: 'USDC', amount: '-5' }],
  });
});

test('before its first line a reporter had published nothing: reported false, never an empty balance', () => {
  const state = fresh();
  recordOwnReport(state, { reporter: 'partner', place: 'p1', key: 'k', assetId: 'USDC', amount: '-3', at: '2026-11-24T10:00:00.000Z' });
  const silent = answerStatement(state, 'GET', q('partner', 'p1', '2026-11-24T09:59:59.999Z'))[1];
  assert.deepEqual(silent, { source: 'report', reporter: 'partner', place: 'p1', reported: false });
  assert.equal(answerStatement(fresh(), 'GET', q('venue', 'v9', '2026-11-24T10:00:00.000Z'))[1].reported, false);
});

test('the same key twice writes once; other facts under it refuse; a bad query never answers a balance', () => {
  const state = fresh();
  const line = { reporter: 'venue', place: 'v1', key: 'f1', assetId: 'USDC', amount: '-5', at: '2026-11-24T10:00:00.000Z' };
  recordOwnReport(state, line);
  recordOwnReport(state, line);
  assert.deepEqual(ownReport(state, 'venue', 'v1', '2026-11-24T10:00:00.000Z').balances, [{ assetId: 'USDC', amount: '-5' }]);
  assert.throws(() => recordOwnReport(state, { ...line, amount: '-6' }), OwnReportError);
  assert.equal(answerStatement(state, 'GET', q('bank', 'v1', '2026-11-24T10:00:00.000Z'))[0], 400);
  assert.equal(answerStatement(state, 'GET', q('venue', 'V 1', '2026-11-24T10:00:00.000Z'))[0], 400);
  assert.equal(answerStatement(state, 'GET', q('venue', 'v1', 'soon'))[0], 400);
  assert.equal(answerStatement(state, 'GET', '/report?reporter=venue')[0], 400);
});
