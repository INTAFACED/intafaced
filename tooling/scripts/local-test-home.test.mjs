/**
 * Unit tests for local-test-home (Home's TEST deposit, notice and inbox row). A stand-in for the stack's doors: no
 * services, no ledger. The live path is proven by J-home-ia-11 #1 on the running stack.
 * Run: node --test tooling/scripts/local-test-home.test.mjs
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEPOSIT_CREDITED_KIND,
  HOME_ASSET,
  HOME_DEPOSIT_AMOUNT,
  HOME_DEPOSIT_CONFIRMATIONS,
  HOME_DEPOSIT_LABEL,
  HOME_NETWORK,
  HOME_NOTICE_TITLE,
  NOTICE_WINDOW_MS,
  applyHome,
  homeStatus,
} from './local-test-home.mjs';

const ADDRESS = '0xfounder';
const ok = (data) => ({ status: 200, json: { result: { data } }, text: '' });
const refused = (code) => ({ status: 400, json: { error: { data: { cause: { code } } } }, text: code });

/** A stand-in stack: svc-pay credits a transfer once per tx, svc-notify files one row per credited deposit. */
function stack({ credit = true, fileRow = true, extraRecord = false, creditAfterReads = 0 } = {}) {
  const state = {
    t: Date.parse('2026-10-29T00:00:00.000Z'),
    addresses: [],
    deposits: new Map(),
    notices: [],
    inbox: [],
    deliveries: 0,
    drafts: [],
    publishKeys: [],
    writes: [],
    reads: 0,
  };
  const txHash = (address, label) => `tx:${address}:${label}`;
  const home = {
    founder: { handle: 'local_test_founder_a', token: 'tok-a' },
    txHash,
    now: () => (state.t += 1_000),
    sleep: async () => {},
    edge: {
      async mutate(mod, proc, input) {
        state.writes.push(`${mod} ${proc}`);
        if (proc === 'deposits.address') {
          assert.deepEqual(input, { assetId: HOME_ASSET, networkId: HOME_NETWORK });
          if (state.addresses.length === 0) state.addresses.push({ addressIndex: 0, address: ADDRESS });
          return ok({ assetId: HOME_ASSET, networkId: HOME_NETWORK, address: ADDRESS, memo: null, qrPayload: null });
        }
        throw new Error(`unexpected mutate ${proc}`);
      },
      async query(mod, proc, input) {
        if (proc === 'deposits.addresses.list') return ok({ items: state.addresses, cap: null, expiryDays: null });
        if (proc === 'deposits.list') {
          state.reads += 1;
          const items = [...state.deposits.values()]
            .filter((row) => row.txHash === input.txId)
            .map((row) => (state.reads > creditAfterReads ? row : { ...row, status: 'confirming' }));
          if (extraRecord && items.length) items.push({ ...items[0], id: 'dup' });
          return ok({ items, total: items.length });
        }
        if (proc === 'notify.notices') {
          assert.equal(input.kind, 'announcement');
          return ok(state.notices);
        }
        if (proc === 'notify.list') return ok({ items: state.inbox, nextCursor: null });
        throw new Error(`unexpected query ${proc}`);
      },
    },
    chainDeposit(address, asset, amount, confirmations, label) {
      state.deliveries += 1;
      assert.deepEqual(
        [asset, amount, confirmations, label],
        [HOME_ASSET, HOME_DEPOSIT_AMOUNT, HOME_DEPOSIT_CONFIRMATIONS, HOME_DEPOSIT_LABEL],
      );
      const tx = txHash(address, label);
      if (state.deposits.has(tx)) return; // the same chain event again: svc-pay recognises it
      state.deposits.set(tx, { id: `dep-${state.deposits.size}`, txHash: tx, amount, status: credit ? 'credited' : 'held' });
      if (credit && fileRow) state.inbox.push({ id: `n-${state.inbox.length}`, kind: DEPOSIT_CREDITED_KIND, params: { txHash: tx } });
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

test('apply makes one credited TEST deposit, one TEST notice and waits for the one inbox row', async () => {
  const { home, state } = stack();
  assert.deepEqual(await applyHome(home), [
    `home deposit: ${HOME_DEPOSIT_AMOUNT} ${HOME_ASSET} on TEST ${HOME_NETWORK} to local_test_founder_a, credited`,
    `home notice: ${HOME_NOTICE_TITLE} published`,
    'home inbox: 1 deposit-credited row for local_test_founder_a',
  ]);
  assert.equal(state.deposits.size, 1);
  assert.equal(state.notices.length, 1);
  assert.equal(state.inbox.length, 1);
});

test('a second apply delivers the same transfer, which makes no second deposit, notice or row', async () => {
  const { home, state } = stack();
  await applyHome(home);
  const again = await applyHome(home);
  assert.equal(state.deliveries, 2);
  assert.equal(state.deposits.size, 1);
  assert.equal(state.drafts.length, 1);
  assert.equal(state.notices.length, 1);
  assert.equal(state.inbox.length, 1);
  assert.equal(again[1], `home notice: ${HOME_NOTICE_TITLE} skipped`);
});

test('a deposit that is not credited stops the seed before any notice is drafted', async () => {
  const { home, state } = stack({ credit: false });
  await assert.rejects(applyHome(home), { message: 'the TEST home deposit was not credited (record held)' });
  assert.deepEqual(state.drafts, []);
});

test('a credit that lands after a few reads is waited for, not refused', async () => {
  const { home, state } = stack({ creditAfterReads: 3 });
  const lines = await applyHome(home);
  assert.match(lines[0], /, credited$/);
  assert.ok(state.reads > 3);
});

test('an ended TEST notice is drafted afresh under the next window key, and each publish names its approval', async () => {
  const { home, state } = stack();
  await applyHome(home);
  state.t += 31 * 24 * 60 * 60_000; // the 30-day notice has ended
  const again = await applyHome(home);
  assert.equal(again[1], `home notice: ${HOME_NOTICE_TITLE} published`);
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

test('a notice window outside 1 minute to 30 days is refused before anything is delivered', async () => {
  for (const noticeMs of [0, 59_999, NOTICE_WINDOW_MS + 1, 90_000.5]) {
    const { home, state } = stack();
    await assert.rejects(applyHome(home, { noticeMs }), /the TEST notice window must be a whole number of ms from 1 minute to 30 days/);
    assert.equal(state.deliveries, 0);
    assert.deepEqual(state.drafts, []);
  }
});

test('another credited deposit in the inbox is not counted as the seeded row', async () => {
  const { home, state } = stack({ fileRow: false });
  state.inbox.push({ id: 'other', kind: DEPOSIT_CREDITED_KIND, params: { txHash: 'tx:someone-else' } });
  await assert.rejects(applyHome(home), { message: "founder a's inbox has 0 deposit-credited rows for the TEST home deposit, not 1" });
});

test('no inbox row within the wait fails the seed by name, before any notice is drafted', async () => {
  const { home, state } = stack({ fileRow: false });
  await assert.rejects(applyHome(home), { message: "founder a's inbox has 0 deposit-credited rows for the TEST home deposit, not 1" });
  assert.deepEqual(state.drafts, []);
});

test('two records for the seeded transfer fail rather than report one', async () => {
  const { home } = stack({ extraRecord: true });
  await assert.rejects(applyHome(home), { message: 'the TEST home deposit has 2 records, not 1' });
});

test('a refused door is reported with its code', async () => {
  const { home } = stack();
  home.edge.mutate = async () => refused('bank.deposit_custody_unset');
  await assert.rejects(applyHome(home), /bank deposits\.address refused \(400\): bank\.deposit_custody_unset/);
});

test('status reads back without writing, before and after apply', async () => {
  const { home, state } = stack();
  assert.deepEqual(await homeStatus(home), [
    'home:',
    '  deposit  none  local_test_founder_a',
    '  notice  none',
    '  inbox  0 deposit-credited rows  local_test_founder_a',
  ]);
  assert.deepEqual(state.writes, []);
  await applyHome(home);
  state.writes = [];
  assert.deepEqual(await homeStatus(home), [
    'home:',
    `  deposit  ${HOME_DEPOSIT_AMOUNT} ${HOME_ASSET} credited  local_test_founder_a`,
    `  notice  ${HOME_NOTICE_TITLE}  published`,
    '  inbox  1 deposit-credited row  local_test_founder_a',
  ]);
  assert.deepEqual(state.writes, []);
});
