// Proves, without starting or touching anything: the test-world script refuses outside the local
// test stack, and its planning functions (welcome credits, founder pick, friend replies) are
// idempotent and skip the right accounts. Run: node tooling/scripts/local-test-world.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GuardError,
  WELCOME_AMOUNTS,
  assertLocalTarget,
  doneKey,
  isSkippedAccount,
  pendingWelcomes,
  pickFounder,
  planReturns,
  returnTransferId,
  seedTransferId,
  welcomeRef,
} from './local-test-world.mjs';

const script = resolve(dirname(fileURLToPath(import.meta.url)), 'local-test-world.mjs');
const run = (home, args) => spawnSync(process.execPath, [script, ...args], { env: { ...process.env, HOME: home }, encoding: 'utf8' });

const home = mkdtempSync(join(tmpdir(), 'local-test-world-test-'));
const state = join(home, '.intafaced', 'local-test-stack');
const marker = (extra = {}) => JSON.stringify({ kind: 'intafaced-local-test-stack', ports: { edge: 14500, ledger: 14501 }, ...extra });
const refuses = (fn, re) => assert.throws(fn, (e) => e instanceof GuardError && re.test(e.message));
try {
  // Guard: no marker, bad marker, foreign host, foreign port, non-http.
  const here = (urls) => () => assertLocalTarget({ home, urls });
  refuses(here(['http://127.0.0.1:14500']), /marker .* not found/);
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, 'LOCAL-TEST-STACK.json'), JSON.stringify({ kind: 'something-else' }));
  refuses(here(['http://127.0.0.1:14500']), /not a local test stack marker/);
  writeFileSync(join(state, 'LOCAL-TEST-STACK.json'), '{not json');
  refuses(here(['http://127.0.0.1:14500']), /unreadable/);
  writeFileSync(join(state, 'LOCAL-TEST-STACK.json'), marker());
  assert.ok(assertLocalTarget({ home, urls: ['http://127.0.0.1:14500', 'http://127.0.0.1:14501'] }).marker);
  refuses(here(['http://example.com:14500']), /not http:\/\/127\.0\.0\.1/);
  refuses(here(['http://10.0.0.5:14500']), /not http:\/\/127\.0\.0\.1/);
  refuses(here(['https://127.0.0.1:14500']), /not http:\/\/127\.0\.0\.1/);
  refuses(here(['http://127.0.0.1:9999']), /not a port of the local test stack/);
  refuses(here(['not a url']), /not a URL/);
  writeFileSync(join(state, 'LOCAL-TEST-STACK.json'), marker({ database: { host: 'db.prod.example' } }));
  refuses(here(['http://127.0.0.1:14500']), /database host/);

  // Guard through the real CLI: refuses (exit 1) with no marker, before any network or database use.
  const empty = mkdtempSync(join(tmpdir(), 'local-test-world-empty-'));
  for (const cmd of ['watch', 'seed', 'status']) {
    const r = run(empty, [cmd]);
    assert.equal(r.status, 1, `${cmd}: ${r.stderr}`);
    assert.match(r.stderr, /refusing: marker .* not found/);
  }
  rmSync(empty, { recursive: true, force: true });

  // Skipped accounts.
  assert.equal(isSkippedAccount('test-market-maker'), true);
  assert.equal(isSkippedAccount('test_market_maker'), true);
  assert.equal(isSkippedAccount('test_taker'), true);
  assert.equal(isSkippedAccount('Luffy'), false);
  assert.equal(isSkippedAccount('test_friend'), false);

  // Welcome plan: only ledger assets, skips the maker, idempotent once done.
  const users = [
    { id: '11111111-1111-4111-8111-111111111111', handle: 'Luffy', email: 'l@example.com', createdAt: '2026-10-13 17:23:43' },
    {
      id: '22222222-2222-4222-8222-222222222222',
      handle: 'test_market_maker',
      email: 'test-market-maker@local-test.invalid',
      createdAt: '2026-10-13 17:40:15',
    },
    {
      id: '33333333-3333-4333-8333-333333333333',
      handle: 'test_friend',
      email: 'test-friend@local.test',
      createdAt: '2026-10-13 18:00:00',
    },
  ];
  const ledgerAssets = ['USDT', 'BTC', 'USD']; // ETH not in the ledger -> not credited
  const first = pendingWelcomes({ users, ledgerAssets, done: new Set() });
  assert.deepEqual(
    first.map((w) => `${w.handle}:${w.asset}:${w.amount}`),
    ['Luffy:USDT:10000', 'Luffy:BTC:0.25', 'test_friend:USDT:10000', 'test_friend:BTC:0.25'],
  );
  assert.equal(first[0].ref, `welcome-${users[0].id}-USDT`);
  assert.equal(welcomeRef('u', 'BTC'), 'welcome-u-BTC');
  assert.ok(first.every((w) => !w.handle.startsWith('test_market_maker')));
  const done = new Set(first.map((w) => doneKey(w.userId, w.asset)));
  assert.deepEqual(pendingWelcomes({ users, ledgerAssets, done }), []); // idempotent
  const withEth = pendingWelcomes({ users: [users[0]], ledgerAssets: [...ledgerAssets, 'ETH'], done });
  assert.deepEqual(
    withEth.map((w) => w.asset),
    ['ETH'],
  ); // a newly listed asset is picked up once
  assert.deepEqual(Object.keys(WELCOME_AMOUNTS), ['USDT', 'BTC', 'ETH']);
  // Refs fit local:fund's --ref rule (letters, digits, dashes; 4-64 chars).
  for (const w of first) assert.match(w.ref, /^[A-Za-z0-9-]{4,64}$/);

  // Founder = newest non-test user, never a test account.
  assert.equal(pickFounder(users).handle, 'Luffy');
  assert.equal(pickFounder([users[1], users[2]]), null);
  const newer = { id: '44444444-4444-4444-8444-444444444444', handle: 'Anna', email: 'a@example.com', createdAt: '2026-10-14 09:00:00' };
  assert.equal(pickFounder([...users, newer]).handle, 'Anna');
  assert.match(seedTransferId(users[0].id, 2), /^world-seed-11111111-2$/);
  assert.ok(seedTransferId(users[0].id, 1).length >= 8 && seedTransferId(users[0].id, 1).length <= 64);

  // Friend replies: only past the cursor, never to self, never twice.
  const friendId = users[2].id;
  const incoming = [
    { seq: 10, txId: 'aaaaaaaa-0000-4000-8000-000000000001', fromUserId: users[0].id, asset: 'USDT', amount: '5' },
    { seq: 11, txId: 'aaaaaaaa-0000-4000-8000-000000000002', fromUserId: friendId, asset: 'USDT', amount: '1' },
    { seq: 12, txId: 'aaaaaaaa-0000-4000-8000-000000000003', fromUserId: users[1].id, asset: 'USDT', amount: '2' },
    { seq: 13, txId: 'aaaaaaaa-0000-4000-8000-000000000004', fromUserId: users[0].id, asset: 'BTC', amount: '0.001' },
  ];
  const plan = planReturns({ incoming, friendId, cursor: 9, answered: new Set(), skipUserIds: new Set([users[1].id]) });
  assert.deepEqual(
    plan.map((r) => r.txId.slice(-1)),
    ['1', '4'],
  );
  assert.equal(plan[0].transferId, returnTransferId(incoming[0].txId));
  assert.match(plan[0].transferId, /^world-return-[0-9a-f]{32}$/);
  assert.deepEqual(planReturns({ incoming, friendId, cursor: 13, answered: new Set() }), []);
  assert.deepEqual(
    planReturns({ incoming, friendId, cursor: 9, answered: new Set(plan.map((r) => r.txId)), skipUserIds: new Set([users[1].id]) }),
    [],
  );

  // The two stand-in operators (local-test-gates.mjs) get no welcome funds and are never picked as the founder.
  assert.equal(isSkippedAccount('local_test_operator_a'), true);
  assert.equal(isSkippedAccount('local_test_operator_b'), true);
  assert.equal(isSkippedAccount('local_test_operators_real_person'), false);
  assert.equal(
    pickFounder([
      { id: 'f', handle: 'Luffy', email: 'a@b.c', createdAt: '2026-10-13 17:23:43' },
      { id: 'o', handle: 'local_test_operator_a', email: 'x@y.z', createdAt: '2026-10-13 19:00:00' },
    ]).id,
    'f',
  );
  assert.deepEqual(pendingWelcomes({ users: [{ id: 'o', handle: 'local_test_operator_b' }], ledgerAssets: ['USDT'], done: new Set() }), []);

  console.log('local-test-world: all checks passed');
} finally {
  rmSync(home, { recursive: true, force: true });
}
