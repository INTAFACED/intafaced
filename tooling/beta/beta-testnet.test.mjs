import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { viewerToken } from './beta-front.mjs';
import { MAX_FUNDED_PER_PERSON, invitedPaths } from './beta-invited.mjs';
import {
  MAX_TRIES,
  RETRY_AFTER_MS,
  TESTNET_GRANT,
  UNKNOWN_AFTER_MS,
  liveDeps,
  readTestnet,
  info,
  judgeAccount,
  judgeLive,
  JUDGE_LIVE_MS,
  testnetCandidates,
  testnetKey,
  testnetStep,
  units,
} from './beta-testnet.mjs';

const alice = viewerToken('alice@gmail.com');
const bob = viewerToken('bob@gmail.com');
const tokens = new Set([alice]);
const full = (...ids) => new Map(ids.map((id) => [id, new Set(['full'])]));
const FUNDER = '0x47e03ee499ba8efff97d8e6459ae2c64e8b28dc6';
const addr = (n) => `0x${String(n).padStart(40, 'a')}`;

/** A testnet and a GitHub the step talks to: every dispatch is counted, and a dispatched run credits on completion. */
function world({ wallets = {}, funderFree = '286', dispatchFails = 0, crashOnDispatch = false } = {}) {
  const w = { dispatches: [], balances: new Map(), runs: new Map(), lines: [], clock: Date.parse('2026-11-25T04:00:00Z') };
  let fails = dispatchFails;
  let crash = crashOnDispatch;
  w.deps = {
    walletOf: async (userId) => wallets[userId] ?? null,
    usdcAt: async (a) => w.balances.get(a) ?? '0',
    funderAddress: async () => FUNDER,
    spotFree: async () => funderFree,
    dispatch: async (to, amount) => {
      if (crash) {
        crash = false;
        throw new Error('crash: the pass died here');
      }
      w.dispatches.push({ to, amount });
      if (fails > 0) {
        fails -= 1;
        return { ok: false, why: 'gh exit 1: HTTP 502' };
      }
      const id = String(1000 + w.dispatches.length);
      w.runs.set(id, { to, amount, status: 'queued' });
      return { ok: true, runId: id };
    },
    runOf: async (id) => w.runs.get(id) ?? null,
  };
  /** Every queued run completes; `conclusion` success credits its destination. */
  w.finishRuns = (conclusion = 'success') => {
    for (const r of w.runs.values()) {
      if (r.status === 'completed') continue;
      Object.assign(r, { status: 'completed', conclusion });
      if (conclusion === 'success') w.balances.set(r.to, String(Number(w.balances.get(r.to) ?? '0') + Number(r.amount)));
    }
  };
  w.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beta-testnet-'));
  w.file = invitedPaths(w.dir).testnet;
  w.step = (candidates) => testnetStep({ file: w.file, candidates, deps: w.deps, log: (l) => w.lines.push(l), now: () => w.clock });
  w.records = () => Object.values(readTestnet(w.file).accounts);
  w.done = () => fs.rmSync(w.dir, { recursive: true });
  return w;
}
const cand = (userId, token = alice) => ({ userId, email: `${token}.${userId}@local-test.invalid`, token });

test('only an invited account holding Full, with no send yet and under the per-person cap, is a candidate', () => {
  const users = [
    { id: 'u1', email: `${alice}.1@local-test.invalid` },
    { id: 'u2', email: `${bob}.1@local-test.invalid` }, // uninvited
    { id: 'u3', email: `${alice}.3@local-test.invalid` }, // unverified
    { id: 'u4', email: 'pubx@local-test.invalid' }, // made on the box
  ];
  const approved = new Map([...full('u1', 'u2', 'u4'), ['u3', new Set(['basic'])]]);
  assert.deepEqual(
    testnetCandidates({ users, approved, tokens, accounts: {} }).map((c) => c.userId),
    ['u1'],
  );
  assert.deepEqual(testnetCandidates({ users, approved, tokens, accounts: { k: { userId: 'u1', token: alice } } }), []);
  // The cap counts every record the person's accounts hold, sent or not; accounts with no record take no place under it,
  // so a person's earlier accounts that never made a wallet don't shut out a later one.
  const many = Array.from({ length: 6 }, (_, i) => ({ id: `m${i}`, email: `${alice}.${i}@local-test.invalid` }));
  const all = full(...many.map((u) => u.id));
  assert.equal(testnetCandidates({ users: many, approved: all, tokens, accounts: {} }).length, many.length);
  const two = { a: { userId: 'm0', token: alice, state: 'sent' }, b: { userId: 'm1', token: alice, state: 'failed' } };
  assert.deepEqual(
    testnetCandidates({ users: many, approved: all, tokens, accounts: two }).map((c) => c.userId),
    ['m2', 'm3', 'm4', 'm5'],
  );
  const three = { ...two, c: { userId: 'm2', token: alice, state: 'dispatched' } };
  assert.deepEqual(testnetCandidates({ users: many, approved: all, tokens, accounts: three }), []);
  assert.deepEqual(TESTNET_GRANT, { asset: 'USDC', amount: '25' });
  assert.equal(testnetKey('u1', '0xAbC'), 'beta-testnet:u1:0xabc');
});

test('a tester with a wallet is sent 25 TEST USDC once, recorded under its business key; a walletless one nothing', async () => {
  const w = world({ wallets: { u1: addr(1).toUpperCase().replace('0X', '0x') } });
  await w.step([cand('u0'), cand('u1')]); // u0 has no wallet yet: skipped, u1 is sent
  assert.deepEqual(w.dispatches, [{ to: addr(1), amount: '25' }]);
  const doc = readTestnet(w.file);
  assert.deepEqual(Object.keys(doc.accounts), [testnetKey('u1', addr(1))]);
  assert.equal(doc.accounts[testnetKey('u1', addr(1))].state, 'dispatched');
  assert.equal(fs.statSync(w.file).mode & 0o777, 0o600);
  await w.step([cand('u0')]); // still in flight: nothing else is dispatched
  assert.equal(w.dispatches.length, 1);
  w.finishRuns('success');
  await w.step([cand('u0')]);
  assert.equal(w.records()[0].state, 'sent');
  for (let i = 0; i < 3; i++) await w.step([cand('u0')]);
  assert.equal(w.dispatches.length, 1);
  assert.equal(w.records().length, 1);
  assert.match(w.lines.at(-1), /25 TEST USDC on the testnet at 0xa+1 \(run 1001\)/);
  w.done();
});

test('a failed dispatch is retried after a wait, at most MAX_TRIES sends, and a failed run too', async () => {
  const w = world({ wallets: { u1: addr(1) }, dispatchFails: 5 });
  await w.step([cand('u1')]);
  assert.equal(w.records()[0].state, 'failed');
  await w.step([]); // too soon
  assert.equal(w.dispatches.length, 1);
  for (let i = 1; i < MAX_TRIES; i++) {
    w.clock += RETRY_AFTER_MS;
    await w.step([]);
  }
  assert.equal(w.dispatches.length, MAX_TRIES);
  assert.match(w.lines.at(-1), new RegExp(`not tried again \\(${MAX_TRIES} of ${MAX_TRIES} tries\\)`));
  w.clock += RETRY_AFTER_MS * 10;
  await w.step([]);
  assert.equal(w.dispatches.length, MAX_TRIES);
  w.done();

  // A run that ends in failure (or is cancelled by the workflow's concurrency group) is sent again.
  const r = world({ wallets: { u1: addr(1) } });
  await r.step([cand('u1')]);
  r.finishRuns('cancelled');
  await r.step([]);
  assert.equal(r.records()[0].state, 'failed');
  r.clock += RETRY_AFTER_MS;
  await r.step([]);
  assert.equal(r.dispatches.length, 2);
  r.finishRuns('success');
  await r.step([]);
  assert.equal(r.records()[0].state, 'sent');
  r.done();
});

test('a run that ended badly but credited the address, or an address that already holds it, is never sent more', async () => {
  const w = world({ wallets: { u1: addr(1), u2: addr(2) } });
  await w.step([cand('u1')]);
  w.runs.get('1001').status = 'completed';
  w.runs.get('1001').conclusion = 'failure';
  w.balances.set(addr(1), '25'); // the venue credited it after the script's last read
  await w.step([]);
  assert.equal(w.records()[0].state, 'sent');
  w.balances.set(addr(2), '40.5');
  await w.step([cand('u2')]);
  assert.equal(w.dispatches.length, 1);
  assert.equal(w.records().find((r) => r.userId === 'u2').state, 'sent');
  w.done();
});

test('a crash between the record and the dispatch never sends twice: it waits, then settles from the address', async () => {
  // The pass dies after writing `dispatching` and before gh answered: the record stands, with no run id.
  const w = world({ wallets: { u1: addr(1) }, crashOnDispatch: true });
  await assert.rejects(w.step([cand('u1')]), /crash/);
  assert.equal(w.records()[0].state, 'dispatching');
  assert.equal(w.records()[0].tries, 1);
  // Every later pass inside UNKNOWN_AFTER_MS sends nothing, for it or anyone else (one send in flight).
  w.deps.walletOf = async (u) => ({ u1: addr(1), u2: addr(2) })[u] ?? null;
  for (let i = 0; i < 5; i++) {
    w.clock += 60_000;
    await w.step([cand('u2')]);
  }
  assert.equal(w.dispatches.length, 0);
  // Had the dispatch gone through, its run credits the address, and the record is sent without a second dispatch.
  w.balances.set(addr(1), '25');
  await w.step([]);
  assert.equal(w.records()[0].state, 'sent');
  assert.equal(w.dispatches.length, 0);
  w.done();

  // Had it not, the record counts as failed only after UNKNOWN_AFTER_MS, and is retried after the usual wait.
  const n = world({ wallets: { u1: addr(1) }, crashOnDispatch: true });
  await assert.rejects(n.step([cand('u1')]), /crash/);
  n.clock += UNKNOWN_AFTER_MS - 1;
  await n.step([]);
  assert.equal(n.records()[0].state, 'dispatching');
  n.clock += 1;
  await n.step([]);
  assert.equal(n.records()[0].state, 'failed');
  n.clock += RETRY_AFTER_MS;
  await n.step([]);
  assert.deepEqual(n.dispatches, [{ to: addr(1), amount: '25' }]);
  assert.equal(n.records()[0].tries, 2);
  n.done();
});

test('a person whose earlier accounts made no wallet still gets their later one sent; never more than the cap', async () => {
  // Six accounts of one person, all Full; only the last four made wallets. The first two take no place under the cap.
  const wallets = Object.fromEntries([2, 3, 4, 5].map((i) => [`m${i}`, addr(10 + i)]));
  const w = world({ wallets });
  const all = Array.from({ length: 6 }, (_, i) => cand(`m${i}`));
  for (let pass = 0; pass < 8; pass++) {
    const sent = new Set(w.records().map((r) => r.userId));
    await w.step(all.filter((c) => !sent.has(c.userId)));
    w.finishRuns();
  }
  assert.deepEqual(
    w
      .records()
      .map((r) => r.userId)
      .sort(),
    ['m2', 'm3', 'm4'],
  );
  assert.equal(w.dispatches.length, MAX_FUNDED_PER_PERSON);
  w.done();
});

test("the daily check's own fresh accounts are not held by the per-person cap; any other account of that invite still is", async () => {
  const judge = 'zenyoda33-0123456789';
  const local = new Set([judge]);
  const email = (i) => `${judge}.ready2026112510${String(i).padStart(2, '0')}@local-test.invalid`;
  assert.equal(judgeAccount(email(1), judge), true);
  assert.equal(judgeAccount(`${judge}.demo1@local-test.invalid`, judge), false);
  assert.equal(judgeAccount(`${alice}.ready202611251000@local-test.invalid`, alice), false);
  assert.equal(judgeAccount(`${judge}.ready1@local-test.invalid`, judge), false);
  const users = [1, 2, 3, 4, 5].map((i) => ({ id: `j${i}`, email: email(i) }));
  users.push({ id: 'd1', email: `${judge}.demo1@local-test.invalid` });
  const approved = full(...users.map((u) => u.id));
  const records = Object.fromEntries([1, 2, 3].map((i) => [`k${i}`, { userId: `j${i}`, token: judge, state: 'sent' }]));
  assert.deepEqual(
    testnetCandidates({ users, approved, tokens: local, accounts: records, now: Date.UTC(2026, 10, 25, 10, 10) }).map((c) => c.userId),
    ['j4', 'j5'],
  );
  // The step sends to a fourth judge account although the invite holds three records.
  const w = world({ wallets: { j4: addr(44), d1: addr(45) } });
  fs.writeFileSync(w.file, JSON.stringify({ accounts: records }));
  await w.step([{ userId: 'j4', email: email(4), token: judge }]);
  assert.equal(w.dispatches.length, 1);
  w.finishRuns();
  await w.step([]);
  // Any other account of that invite is held: its three records stand.
  await w.step([{ userId: 'd1', email: `${judge}.demo1@local-test.invalid`, token: judge }]);
  assert.equal(w.dispatches.length, 1);
  w.done();
});

test('a funder under the grant sends nothing and says so once in round.log', async () => {
  const w = world({ wallets: { u1: addr(1) }, funderFree: '24.99' });
  await w.step([cand('u1')]);
  await w.step([cand('u1')]);
  assert.equal(w.dispatches.length, 0);
  assert.equal(w.records().length, 0);
  assert.equal(w.lines.length, 1);
  assert.match(w.lines[0], new RegExp(`NOT sent to ${addr(1)}: the funder ${FUNDER} holds 24.99 free TEST USDC, under 25`));
  // The line says how the funder refills, so nobody asks a person for a faucet deposit already made (#11030).
  assert.match(w.lines[0], /its one faucet claim is spent/);
  assert.match(w.lines[0], /only a send from another funded testnet account refills it/);
  w.done();
});

test('amounts are compared as scaled integers, and the live reads sum perps and spot USDC', async () => {
  assert.equal(units('25'), units('25.0'));
  assert.ok(units('24.999999999') < units('25'));
  assert.throws(() => units('-1'));
  assert.throws(() => units('1e3'));
  const answers = {
    clearinghouseState: { marginSummary: { accountValue: '20.5' } },
    spotClearinghouseState: { balances: [{ coin: 'USDC', total: '286.0', hold: '1.5' }] },
  };
  const fetchImpl = async (_url, init) => ({ ok: true, json: async () => answers[JSON.parse(init.body).type] });
  const deps = liveDeps({ fetchImpl });
  assert.equal(await deps.usdcAt(addr(1)), '306.5');
  assert.equal(await deps.spotFree(FUNDER), '284.5');
});

test('a testnet read the shared address answers 429 is tried again after 2, 4 and 8 s; a fourth 429 stops the pass', async () => {
  const run = async (codes) => {
    const waits = [];
    let calls = 0;
    const fetchImpl = async () => {
      const status = codes[calls++] ?? 200;
      return { ok: status === 200, status, json: async () => ({ calls }) };
    };
    try {
      return { out: await info({ type: 'spotClearinghouseState', user: '0xa' }, fetchImpl, async (ms) => waits.push(ms)), waits, calls };
    } catch (e) {
      return { error: e.message, waits, calls };
    }
  };
  assert.deepEqual(await run([429, 429, 200]), { out: { calls: 3 }, waits: [2000, 4000], calls: 3 });
  assert.deepEqual(await run([429, 429, 429, 429]), {
    error: 'testnet info spotClearinghouseState: HTTP 429',
    waits: [2000, 4000, 8000],
    calls: 4,
  });
  assert.deepEqual(await run([500]), { error: 'testnet info spotClearinghouseState: HTTP 500', waits: [], calls: 1 });
});

test("a judge account whose walk has ended is never sent: the walk's passkey is gone, so the grant would strand", () => {
  const judge = 'zenyoda33-0123456789';
  const at = Date.UTC(2026, 10, 25, 14, 2);
  const email = `${judge}.ready202611251402@local-test.invalid`;
  assert.equal(judgeLive(email, at + 60_000), true);
  assert.equal(judgeLive(email, at + JUDGE_LIVE_MS), true);
  assert.equal(judgeLive(email, at + JUDGE_LIVE_MS + 1), false);
  assert.equal(judgeLive(email, at - JUDGE_LIVE_MS - 60_000), false, 'a stamp far in the future is not live either');
  assert.equal(judgeLive(`${judge}.demo1@local-test.invalid`, at), false);
  const users = [
    { id: 'old', email },
    { id: 'new', email: `${judge}.ready202611260000@local-test.invalid` },
    { id: 'demo', email: `${judge}.demo1@local-test.invalid` },
  ];
  const approved = full('old', 'new', 'demo');
  assert.deepEqual(
    testnetCandidates({ users, approved, tokens: new Set([judge]), accounts: {}, now: Date.UTC(2026, 10, 26, 0, 5) }).map((c) => c.userId),
    ['new', 'demo'],
    'the ended walk is skipped; a live walk and an ordinary account of the invite are not',
  );
});
