import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { viewerToken } from './beta-front.mjs';
import { betaPaths, invitedPassDue } from './beta-host.mjs';
import {
  GRANT,
  MAX_FUNDED_PER_PERSON,
  PARTNER_FUND_ID,
  TOKEN_RE,
  grantRef,
  invitedOwner,
  planPartner,
  planPass,
  readInvited,
  recordInvited,
} from './beta-invited.mjs';

const alice = viewerToken('alice@gmail.com');
const bob = viewerToken('bob@gmail.com');
const tokens = new Set([alice]);
const full = (...ids) => new Map(ids.map((id) => [id, new Set(['full'])]));

test('the mailbox token of every Access email has the shape the invited list keeps', () => {
  for (const e of ['alice@gmail.com', 'A.B+x@Example.io', 'x@y.z']) assert.match(viewerToken(e), TOKEN_RE);
  for (const bad of ['', 'alice', 'alice-gmail-com', 'alice-gmail-com-ZZZZZZZZZZ', 'a.b-0123456789', '../x-0123456789'])
    assert.doesNotMatch(bad, TOKEN_RE);
});

test("an account is an invited person's only at their token, or their token and a dot, at local-test.invalid", () => {
  assert.equal(invitedOwner(`${alice}@local-test.invalid`, tokens), alice);
  assert.equal(invitedOwner(`${alice}.1@local-test.invalid`, tokens), alice);
  assert.equal(invitedOwner(`${alice.toUpperCase()}.Two@LOCAL-TEST.INVALID`, tokens), alice);
  // Uninvited: another person's token, a lookalike, another domain, the token's readable part alone.
  assert.equal(invitedOwner(`${bob}.1@local-test.invalid`, tokens), null);
  assert.equal(invitedOwner(`${alice}x@local-test.invalid`, tokens), null);
  assert.equal(invitedOwner(`x${alice}@local-test.invalid`, tokens), null);
  assert.equal(invitedOwner(`${alice}.1@local-test.invalid.evil.com`, tokens), null);
  assert.equal(invitedOwner(`${alice}.1@gmail.com`, tokens), null);
  assert.equal(invitedOwner('alice@gmail.com', tokens), null);
  assert.equal(invitedOwner(`${alice}.@local-test.invalid`, tokens), null);
  assert.equal(invitedOwner(null, tokens), null);
});

test('a pass approves and funds the invited, and leaves everyone else as they are', () => {
  const users = [
    { id: 'u1', email: `${alice}.1@local-test.invalid` },
    { id: 'u2', email: `${bob}.1@local-test.invalid` },
    { id: 'u3', email: 'pubx@local-test.invalid' },
  ];
  const pending = users.map((u) => ({ userId: u.id, tier: 'full' }));
  assert.deepEqual(planPass({ users, approved: new Map(), pending, tokens, granted: {} }), { approve: ['u1'], fund: [] });
  assert.deepEqual(planPass({ users, approved: full('u1', 'u2', 'u3'), pending: [], tokens, granted: {} }), {
    approve: [],
    fund: [{ userId: 'u1', email: users[0].email, token: alice }],
  });
  // Nobody recorded: nothing at all.
  assert.deepEqual(planPass({ users, approved: full('u1'), pending, tokens: new Set(), granted: {} }), { approve: [], fund: [] });
});

test('TEST funds are capped: once per account, at most MAX_FUNDED_PER_PERSON accounts per person', () => {
  const users = Array.from({ length: 6 }, (_, i) => ({ id: `u${i}`, email: `${alice}.${i}@local-test.invalid` }));
  const approved = full(...users.map((u) => u.id));
  const first = planPass({ users, approved, pending: [], tokens, granted: {} });
  assert.equal(first.fund.length, MAX_FUNDED_PER_PERSON);
  const granted = Object.fromEntries(first.fund.map((f) => [f.userId, { token: f.token }]));
  assert.deepEqual(planPass({ users, approved, pending: [], tokens, granted }).fund, []);
  // A basic-only account waits for full; a granted one is never funded twice.
  assert.deepEqual(
    planPass({ users: users.slice(0, 1), approved: new Map([['u0', new Set(['basic'])]]), pending: [], tokens, granted: {} }).fund,
    [],
  );
  assert.deepEqual(planPass({ users: users.slice(0, 1), approved, pending: [], tokens, granted: { u0: { token: alice } } }).fund, []);
  assert.deepEqual(GRANT, { asset: 'USDT', amount: '1000' });
  assert.equal(grantRef('2f1c7a3e-0000-4000-8000-000000000000'), 'beta-invite-2f1c7a3e-0000-4000-8000-000000000000');
  assert.match(grantRef('2f1c7a3e-0000-4000-8000-000000000000'), /^[A-Za-z0-9-]{4,64}$/); // local:fund's --ref rule
});

test("a granted account's TEST funds are kept at the TEST partner on every pass, as that person, while signed in (#10632)", () => {
  const granted = {
    u1: { token: alice, amount: GRANT.amount },
    u2: { token: alice, amount: GRANT.amount, partnerAt: '2026-11-24T00:00:00.000Z' },
    u3: { token: bob, amount: GRANT.amount },
    u4: { token: alice, amount: GRANT.amount },
  };
  const sessions = new Map([
    ['u1', 's1'],
    ['u2', 's2'],
    ['u3', 's3'],
  ]);
  // u1 first time (a line), u2 again (kept silently, so a restarted partner is funded again), u3's token is no longer
  // recorded, u4 is not signed in and waits.
  assert.deepEqual(planPartner({ granted, tokens, sessions }), [
    { userId: 'u1', sessionId: 's1', first: true },
    { userId: 'u2', sessionId: 's2', first: false },
  ]);
  assert.deepEqual(planPartner({ granted: {}, tokens, sessions }), []);
  assert.deepEqual(planPartner({ granted, tokens, sessions: new Map() }), []);
  // One fixed fund id: the partner pays it in once per person, so a repeat pass credits nothing.
  assert.equal(PARTNER_FUND_ID, 'beta-invite:v1');
});

test('the mailbox records each Access viewer once, privately, and never a malformed one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beta-invited-'));
  const file = betaPaths(dir).invited;
  assert.equal(file, path.join(dir, '.intafaced', 'beta', 'invited.json'));
  assert.equal(readInvited(file).size, 0);
  assert.equal(recordInvited(file, alice), true);
  assert.equal(recordInvited(file, alice), false);
  assert.equal(recordInvited(file, 'not a token'), false);
  assert.deepEqual([...readInvited(file)], [alice]);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fs.rmSync(dir, { recursive: true });
});

test('the invited pass runs only on an up stack someone invited has opened, one at a time', () => {
  assert.equal(invitedPassDue({ state: 'up', invited: 1, running: false }), true);
  assert.equal(invitedPassDue({ state: 'up', invited: 0, running: false }), false);
  assert.equal(invitedPassDue({ state: 'up', invited: 1, running: true }), false);
  for (const state of ['down', 'blocked', 'refused', undefined]) assert.equal(invitedPassDue({ state, invited: 1, running: false }), false);
});
