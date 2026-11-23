/**
 * Unit tests for local-test-home (Home's TEST wallet, venue funds, partner balance, notice and inbox row). A stand-in for
 * the stack's doors: no services, no ledger. The live path is proven by J-home-ia-11 #1 and #3 on the running stack.
 * Run: node --test tooling/scripts/local-test-home.test.mjs
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  HOME_FUND_IDS,
  HOME_NOTICE_TITLE,
  HOME_PARTNER_AMOUNT,
  HOME_PARTNER_ASSET,
  HOME_SENDER_AMOUNT,
  HOME_TRANSFER_AMOUNT,
  HOME_TRANSFER_ID,
  HOME_VENUE_AMOUNT,
  HOME_VENUE_ASSET,
  HOME_VENUE_REF,
  NOTICE_WINDOW_MS,
  TRANSFER_RECEIVED_KIND,
  applyHome,
  homeStatus,
} from './local-test-home.mjs';

const WALLET = '0x00000000000000000000000000000000000000a1';
const A = { handle: 'local_test_founder_a', userId: 'user-a', token: 'tok-a' };
const B = { handle: 'local_test_founder_b', userId: 'user-b', token: 'tok-b' };
const PARTNER = 'TEST partner bank';
const VENUE = 'TEST venue simulator';
const ok = (data) => ({ status: 200, json: { result: { data } }, text: '' });
const refused = (code) => ({ status: 400, json: { error: { data: { cause: { code } } } }, text: code });
const add = (x, y) => String(Number(x) + Number(y));

/**
 * A stand-in stack: the TEST partner pays in once per fund id and moves a payment once per transfer id, svc-notify files
 * one row per payment, the TEST venue credits once per reference, and the TEST chain funds a wallet with no TEST ETH.
 */
function stack({ fileRow = true, ledgerMove = false, venue = true } = {}) {
  const state = {
    t: Date.parse('2026-11-24T00:00:00.000Z'),
    wallet: null,
    gas: 0,
    fundings: 0,
    venue: new Map(),
    partner: { 'user-a': '0', 'user-b': '0' },
    custody: {},
    funds: new Set(),
    transfers: new Set(),
    notices: [],
    inbox: [],
    drafts: [],
    publishKeys: [],
    writes: [],
  };
  const tokenOf = (token) => (token === A.token ? A : token === B.token ? B : assert.fail(`unknown token ${token}`));
  const home = {
    founder: A,
    sender: B,
    now: () => (state.t += 1_000),
    sleep: async () => {},
    async wallet() {
      state.wallet ??= { address: WALLET };
      return state.wallet;
    },
    knownWallet: async () => state.wallet,
    async fundWallet(address) {
      assert.equal(address, WALLET);
      if (state.gas > 0) return 'already funded';
      state.gas = 1;
      state.fundings += 1;
      return 'funded with TEST ETH and TEST USD';
    },
    async venueDeposit(address, asset, amount, ref) {
      assert.deepEqual([address, asset, amount, ref], [WALLET, HOME_VENUE_ASSET, HOME_VENUE_AMOUNT, HOME_VENUE_REF]);
      if (state.venue.has(ref)) return { name: VENUE, credited: false };
      state.venue.set(ref, amount);
      return { name: VENUE, credited: true };
    },
    async venueBalance(address, asset) {
      assert.equal(asset, HOME_VENUE_ASSET);
      if (!venue) return null;
      return { name: VENUE, total: [...state.venue.values()].reduce(add, '0') };
    },
    edge: {
      async mutate(mod, proc, input, token) {
        const who = tokenOf(token);
        state.writes.push(`${mod} ${proc} ${who.handle}`);
        if (proc === 'testPartner.set') {
          assert.deepEqual(input, { custody: 'off' });
          state.custody[who.userId] = 'off';
          return ok({ custody: 'off' });
        }
        if (proc === 'testPartner.fund') {
          assert.equal(input.assetId, HOME_PARTNER_ASSET);
          const key = `${who.userId}|${input.fundId}`;
          if (!state.funds.has(key)) {
            state.funds.add(key);
            state.partner[who.userId] = add(state.partner[who.userId], input.amount);
          }
          return ok({ label: PARTNER, assetId: input.assetId, balance: state.partner[who.userId], asOf: new Date(state.t).toISOString() });
        }
        if (proc === 'transfers.toUser') {
          assert.equal(who, B);
          assert.deepEqual(input, {
            transferId: HOME_TRANSFER_ID,
            fromSpaceId: 'space-user-b',
            toUserId: A.userId,
            amount: HOME_TRANSFER_AMOUNT,
          });
          if (ledgerMove)
            return ok({ ledgerTxId: 'tx-1', partnerMove: null, amount: input.amount, note: null, reference: null, requestId: null });
          if (!state.transfers.has(input.transferId)) {
            state.transfers.add(input.transferId);
            state.partner['user-b'] = add(state.partner['user-b'], `-${input.amount}`);
            state.partner['user-a'] = add(state.partner['user-a'], input.amount);
            if (fileRow)
              state.inbox.push({ id: `n-${state.inbox.length}`, kind: TRANSFER_RECEIVED_KIND, params: { transferId: input.transferId } });
          }
          const partnerMove = { id: 'move-1', label: PARTNER };
          return ok({ ledgerTxId: null, partnerMove, amount: input.amount, note: null, reference: null, requestId: null });
        }
        throw new Error(`unexpected mutate ${proc}`);
      },
      async query(mod, proc, input, token) {
        if (proc === 'spaces.list') {
          const who = tokenOf(token);
          if (state.custody[who.userId] !== 'off') return ok([]);
          const heldAt = { label: PARTNER, asOf: new Date(state.t).toISOString() };
          return ok([
            { id: `space-${who.userId}`, kind: 'primary', assetId: HOME_PARTNER_ASSET, balance: state.partner[who.userId], heldAt },
          ]);
        }
        if (proc === 'notify.notices') {
          assert.equal(input.kind, 'announcement');
          return ok(state.notices);
        }
        if (proc === 'notify.list') {
          assert.equal(tokenOf(token), A);
          return ok({ items: state.inbox, nextCursor: null });
        }
        throw new Error(`unexpected query ${proc}`);
      },
    },
    async draftNotice(input, key) {
      state.drafts.push(key);
      assert.equal(input.kind, 'announcement');
      assert.equal(input.title, HOME_NOTICE_TITLE);
      return { id: `notice-${state.drafts.length}`, version: 1, status: 'draft', ...input };
    },
    async publishNotice(row, publishKey) {
      state.publishKeys.push(publishKey(`approval-${state.publishKeys.length + 1}`));
      state.notices.push({ id: row.id, title: row.title, status: 'published', startsAt: row.startsAt, endsAt: row.endsAt });
      return { id: row.id };
    },
  };
  return { home, state };
}

const APPLIED = [
  `home wallet: ${WALLET} on the TEST chain, funded with TEST ETH and TEST USD`,
  `home venue: ${HOME_VENUE_AMOUNT} ${HOME_VENUE_ASSET} at ${VENUE} for ${WALLET}, credited`,
  `home partner: ${HOME_PARTNER_AMOUNT} ${HOME_PARTNER_ASSET} at ${PARTNER} for ${A.handle}, and ${HOME_TRANSFER_AMOUNT} ${HOME_PARTNER_ASSET} from ${B.handle}`,
  `home notice: ${HOME_NOTICE_TITLE} published`,
  `home inbox: 1 transfer-received row for ${A.handle}`,
];

test('apply gives founder a a TEST wallet, TEST venue funds and a TEST partner balance, one TEST notice and one inbox row', async () => {
  const { home, state } = stack();
  assert.deepEqual(await applyHome(home), APPLIED);
  assert.equal(state.fundings, 1);
  assert.deepEqual([...state.venue], [[HOME_VENUE_REF, HOME_VENUE_AMOUNT]]);
  // Both founders' bank money is at the partner; founder b paid founder a once, by a partner move.
  assert.deepEqual(state.custody, { 'user-a': 'off', 'user-b': 'off' });
  assert.deepEqual(state.funds, new Set([`user-a|${HOME_FUND_IDS.a}`, `user-b|${HOME_FUND_IDS.b}`]));
  assert.equal(state.partner['user-a'], add(HOME_PARTNER_AMOUNT, HOME_TRANSFER_AMOUNT));
  assert.equal(state.partner['user-b'], add(HOME_SENDER_AMOUNT, `-${HOME_TRANSFER_AMOUNT}`));
  assert.equal(state.notices.length, 1);
  assert.equal(state.inbox.length, 1);
});

test('a second apply makes nothing new: no second funding, venue credit, partner pay-in, payment, notice or row', async () => {
  const { home, state } = stack();
  await applyHome(home);
  const again = await applyHome(home);
  assert.equal(state.fundings, 1);
  assert.equal(state.venue.size, 1);
  assert.equal(state.partner['user-a'], add(HOME_PARTNER_AMOUNT, HOME_TRANSFER_AMOUNT));
  assert.equal(state.transfers.size, 1);
  assert.equal(state.drafts.length, 1);
  assert.equal(state.inbox.length, 1);
  assert.deepEqual(again, [
    `home wallet: ${WALLET} on the TEST chain, already funded`,
    `home venue: ${HOME_VENUE_AMOUNT} ${HOME_VENUE_ASSET} at ${VENUE} for ${WALLET}, already there`,
    APPLIED[2],
    `home notice: ${HOME_NOTICE_TITLE} skipped`,
    APPLIED[4],
  ]);
});

test('a payment the ledger posted instead of the partner stops the seed by name, before any notice', async () => {
  const { home, state } = stack({ ledgerMove: true });
  await assert.rejects(applyHome(home), {
    message: `the TEST payment to ${A.handle} was not a partner move (ledger tx-1), so Home is not seeded`,
  });
  assert.deepEqual(state.drafts, []);
});

test('an ended TEST notice is drafted afresh under the next window key, and each publish names its approval', async () => {
  const { home, state } = stack();
  await applyHome(home);
  state.t += 31 * 24 * 60 * 60_000; // the 30-day notice has ended
  const again = await applyHome(home);
  assert.equal(again[3], `home notice: ${HOME_NOTICE_TITLE} published`);
  assert.equal(state.drafts.length, 2);
  assert.notEqual(state.drafts[0], state.drafts[1]);
  assert.match(state.drafts[0], new RegExp(`^local-test-seed:home-notice:draft:v1:${NOTICE_WINDOW_MS}:\\d+$`));
  assert.deepEqual(state.publishKeys, [
    'local-test-seed:home-notice:publish:notice-1:approval-1',
    'local-test-seed:home-notice:publish:notice-2:approval-2',
  ]);
});

test('a short notice window ends the notice within minutes, and the next run drafts a new one under its own key', async () => {
  const { home, state } = stack();
  await applyHome(home, { noticeMs: 6 * 60_000 });
  const [first] = state.notices;
  assert.equal(Date.parse(first.endsAt) - Date.parse(first.startsAt), 7 * 60_000); // drafted a minute back, open 6 ahead
  assert.match(state.drafts[0], /^local-test-seed:home-notice:draft:v1:360000:\d+$/);
  state.t += 7 * 60_000;
  await applyHome(home, { noticeMs: 6 * 60_000 });
  assert.equal(state.drafts.length, 2);
  assert.notEqual(state.drafts[0], state.drafts[1]);
});

test('a notice window outside 1 minute to 30 days is refused before anything is made', async () => {
  for (const noticeMs of [0, 59_999, NOTICE_WINDOW_MS + 1, 90_000.5]) {
    const { home, state } = stack();
    await assert.rejects(applyHome(home, { noticeMs }), /the TEST notice window must be a whole number of ms from 1 minute to 30 days/);
    assert.equal(state.wallet, null);
    assert.deepEqual(state.writes, []);
    assert.deepEqual(state.drafts, []);
  }
});

test('another payment in founder a’s inbox is not counted as the seeded row', async () => {
  const { home, state } = stack({ fileRow: false });
  state.inbox.push({ id: 'other', kind: TRANSFER_RECEIVED_KIND, params: { transferId: 'someone-else' } });
  await assert.rejects(applyHome(home), { message: "founder a's inbox has 0 rows for the TEST payment, not 1" });
  assert.deepEqual(state.drafts, []);
});

test('a refused door is reported with its code', async () => {
  const { home } = stack();
  home.edge.mutate = async () => refused('bank.partner_down');
  await assert.rejects(applyHome(home), /testPartner\.set for local_test_founder_a refused \(400\): bank\.partner_down/);
});

test('status reads back without writing, before and after apply, and says so when no TEST venue runs', async () => {
  const { home, state } = stack();
  assert.deepEqual(await homeStatus(home), [
    'home:',
    '  wallet  none',
    '  venue  none',
    `  partner  none  ${A.handle}`,
    '  notice  none',
    `  inbox  0 transfer-received rows  ${A.handle}`,
  ]);
  assert.deepEqual(state.writes, []);
  await applyHome(home);
  state.writes = [];
  assert.deepEqual(await homeStatus(home), [
    'home:',
    `  wallet  ${WALLET}`,
    `  venue  ${HOME_VENUE_AMOUNT} ${HOME_VENUE_ASSET}  ${VENUE}`,
    `  partner  ${add(HOME_PARTNER_AMOUNT, HOME_TRANSFER_AMOUNT)} ${HOME_PARTNER_ASSET}  ${PARTNER}  ${A.handle}`,
    `  notice  ${HOME_NOTICE_TITLE}  published`,
    `  inbox  1 transfer-received row  ${A.handle}`,
  ]);
  assert.deepEqual(state.writes, []);
  const off = stack({ venue: false });
  await applyHome(off.home);
  assert.equal((await homeStatus(off.home))[2], '  venue  no TEST venue running');
});
