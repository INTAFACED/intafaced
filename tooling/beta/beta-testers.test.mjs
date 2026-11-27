import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ACCOUNT_CALL_MSG, STUCK_AFTER_MS, parseCallLine, readCalls, testerView, viewText } from './beta-testers.mjs';

const TOKEN = 'walker-0123456789';
const tokens = new Set([TOKEN]);
const T0 = Date.parse('2026-11-27T09:00:00.000Z');
const min = (n) => T0 + n * 60_000;
const walker = {
  id: 'aaaaaaaa-0000-4000-8000-000000000001',
  email: `${TOKEN}.ready1@local-test.invalid`,
  createdAt: '2026-11-27T09:00:00Z',
};
const outsider = { id: 'bbbbbbbb-0000-4000-8000-000000000002', email: 'mm@market.local', createdAt: '2026-11-27T08:00:00Z' };
const call = (n, method, p, status, extra = {}) => ({
  level: 30,
  time: min(n),
  msg: ACCOUNT_CALL_MSG,
  accountId: walker.id,
  viaKey: false,
  method,
  path: p,
  status,
  code: null,
  ...extra,
});
const REFUSAL = 'Order must have minimum value of $10. asset=3';
const walk = [
  call(1, 'POST', '/api/protocol/trpc/embeddedWallet.create', 200),
  call(3, 'GET', '/api/v1/venue/session', 200),
  call(4, 'POST', '/api/v1/venue/prepare', 200),
  call(4, 'POST', '/api/v1/venue/submit', 200), // the builder-fee approval: not an order
  call(5, 'POST', '/api/v1/venue/preview', 422, { code: 'trade.venue.rejected', refusal: REFUSAL }),
  call(6, 'POST', '/api/v1/venue/preview', 422, { code: 'trade.venue.rejected', refusal: REFUSAL }),
  call(6, 'GET', '/api/v1/venue/deposits', 422, { code: 'trade.venue.rejected', refusal: 'a polled read' }),
];

function view(lines, now = min(7)) {
  const calls = new Map([[walker.id, lines.map((l) => parseCallLine(JSON.stringify(l)))]]);
  const granted = { [walker.id]: { token: TOKEN, at: new Date(min(2)).toISOString() } };
  return testerView({ users: [outsider, walker], tokens, granted, testnet: [], calls, now });
}

test('only invited accounts are shown, by account id, never by email', () => {
  const rows = view(walk);
  assert.deepEqual(
    rows.map((r) => r.accountId),
    [walker.id],
  );
  const text = viewText(rows, { callLines: walk.length, logFile: 'edge.log' });
  assert.ok(!text.includes('@'), text);
  assert.ok(!text.includes(TOKEN), text);
});

test('a walk shows each stage it reached, and a refused order under the tester with the venue words', () => {
  const [r] = view(walk);
  assert.deepEqual(r.stages, {
    signedUp: '2026-11-27T09:00:00.000Z',
    wallet: new Date(min(1)).toISOString(),
    funded: new Date(min(2)).toISOString(),
    desk: new Date(min(3)).toISOString(),
    firstOrder: null,
  });
  assert.equal(r.refusals.length, 1);
  assert.deepEqual(r.refusals[0], {
    at: new Date(min(6)).toISOString(),
    count: 2,
    path: '/api/v1/venue/preview',
    status: 422,
    code: 'trade.venue.rejected',
    text: REFUSAL,
  });
  assert.match(r.stuck, /POST \/api\/v1\/venue\/preview answered 422 trade.venue.rejected after their last stage/);
  assert.match(
    viewText([r], { callLines: 1, logFile: 'edge.log' }),
    /venue refused .*x2.*"Order must have minimum value of \$10. asset=3"/,
  );
});

test('a submit after the order preview is the first order, and clears the stuck mark', () => {
  const [r] = view([...walk, call(7, 'POST', '/api/v1/venue/preview', 200), call(8, 'POST', '/api/v1/venue/submit', 200)], min(200));
  assert.equal(r.stages.firstOrder, new Date(min(8)).toISOString());
  assert.equal(r.stuck, null);
  assert.deepEqual(r.lastAction, { at: new Date(min(8)).toISOString(), call: 'POST /api/v1/venue/submit', status: 200 });
});

test('no new stage for 30 minutes short of a first order is stuck; under 30 is not', () => {
  const quiet = walk.slice(0, 2);
  assert.equal(view(quiet, min(3) + STUCK_AFTER_MS - 1)[0].stuck, null);
  assert.match(view(quiet, min(3) + STUCK_AFTER_MS)[0].stuck, /no new stage for 30 min/);
});

test('a server error is listed and marks the tester stuck', () => {
  const [r] = view([...walk.slice(0, 2), call(4, 'GET', '/api/v1/venue/balances', 503, { code: 'ExchangeNotAvailable' })]);
  assert.deepEqual(r.errors, [
    { at: new Date(min(4)).toISOString(), count: 1, call: 'GET /api/v1/venue/balances', status: 503, code: 'ExchangeNotAvailable' },
  ]);
  assert.match(r.stuck, /503/);
});

test('readCalls reads only the account call lines from an edge log', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beta-testers-'));
  const file = path.join(dir, 'edge.log');
  fs.writeFileSync(
    file,
    [
      JSON.stringify({ level: 30, time: min(0), msg: 'incoming request', req: { url: '/api/v1/markets' } }),
      'not json',
      ...walk.map((l) => JSON.stringify(l)),
      JSON.stringify({ ...walk[0], accountId: outsider.id }),
    ].join('\n'),
  );
  const { calls, lines } = await readCalls(file, new Set([walker.id]));
  assert.equal(lines, walk.length + 1);
  assert.equal(calls.get(walker.id).length, walk.length);
  assert.equal(calls.has(outsider.id), false);
  assert.deepEqual((await readCalls(path.join(dir, 'missing.log'))).lines, 0);
  fs.rmSync(dir, { recursive: true });
});
