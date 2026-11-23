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
  HOME_PARTNER_AMOUNT,
  HOME_PARTNER_FUND_ID,
  HOME_PARTNER_NOTE,
  HOME_PARTNER_TRANSFER_ID,
  HOME_VENUE_AMOUNT,
  HOME_VENUE_ASSET,
  HOME_VENUE_DEPOSIT_LABEL,
  HOME_WALLET_FILE,
  NOTICE_WINDOW_MS,
  TRANSFER_RECEIVED_KIND,
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

// ── The launch model (OWNER 226): the user-venue door is on ──────────────────────────────────────────────────────────

const WALLET = `0x${'ab'.repeat(20)}`;
const VENUE = { id: 'test-venue-sim', displayName: 'TEST venue simulator', proofLevel: 'simulator' };
const PARTNER = 'TEST partner bank';

/**
 * The same stand-in on the launch model: svc-trade's door answers with a TEST venue, the TEST venue credits a deposit
 * once per reference, the TEST partner bank pays in once per fund id and moves a send once per transfer id, and
 * svc-notify files one row for the person a send paid. Amounts are whole TEST units, held as bigints.
 */
function launchStack({ door = {}, venueId = VENUE.id, fileRow = true, postedByLedger = false } = {}) {
  const { home, state } = stack();
  Object.assign(state, {
    wallet: null,
    chainFunds: 0,
    refs: new Set(),
    venue: new Map(),
    custody: new Map(),
    partner: new Map(),
    funds: new Set(),
    sends: new Map(),
  });
  const who = { 'tok-a': 'user-a', 'tok-b': 'user-b' };
  const credit = (book, key, amount) => book.set(key, (book.get(key) ?? 0n) + BigInt(amount));
  home.founder.userId = 'user-a';
  home.sender = { handle: 'local_test_founder_b', token: 'tok-b' };
  home.venueDoor = async () => ({ enabled: true, available: true, venue: VENUE, test: true, chainId: 84532, builder: null, ...door });
  home.testVenue = async (route, body) => {
    if (route === '/venue') return { status: 200, json: { label: 'TEST', venue: { ...VENUE, id: venueId }, chainId: 84532 }, text: '' };
    assert.deepEqual(body.account, { venueId: VENUE.id, owner: WALLET, subAccount: null });
    if (route === '/test/deposit') {
      state.writes.push('venue /test/deposit');
      assert.deepEqual([body.asset, body.amount], [HOME_VENUE_ASSET, HOME_VENUE_AMOUNT]);
      assert.equal(body.depositRef, `84532:tx:${WALLET}:${HOME_VENUE_DEPOSIT_LABEL}:0`);
      const credited = !state.refs.has(body.depositRef);
      if (credited) credit(state.venue, WALLET, body.amount);
      state.refs.add(body.depositRef);
      return { status: 200, json: { credited }, text: '' };
    }
    if (route === '/balances') {
      const total = state.venue.get(WALLET);
      const value = total === undefined ? [] : [{ asset: HOME_VENUE_ASSET, free: String(total), locked: '0', total: String(total) }];
      return { status: 200, json: { venueId: VENUE.id, value, asOf: new Date(state.t).toISOString() }, text: '' };
    }
    throw new Error(`unexpected TEST venue call ${route}`);
  };
  home.wallet = async ({ create }) => {
    if (state.wallet) return { address: state.wallet, created: false };
    if (!create) return null;
    state.writes.push('wallet file');
    state.wallet = WALLET;
    return { address: WALLET, created: true };
  };
  home.fundWallet = async (address) => {
    assert.equal(address, WALLET);
    state.chainFunds += 1;
    return state.chainFunds === 1 ? 'funded with TEST ETH and TEST USD' : 'already funded';
  };
  const base = home.edge;
  home.edge = {
    async mutate(mod, proc, input, token) {
      const user = who[token];
      if (proc === 'testPartner.set') {
        state.writes.push(`bank ${proc} ${user}`);
        assert.deepEqual(input, { custody: 'off' });
        state.custody.set(user, 'off');
        return ok({ label: PARTNER, custody: 'off' });
      }
      if (proc === 'testPartner.fund') {
        state.writes.push(`bank ${proc} ${user}`);
        assert.deepEqual([user, input], ['user-b', { fundId: HOME_PARTNER_FUND_ID, assetId: HOME_ASSET, amount: HOME_PARTNER_AMOUNT }]);
        if (!state.funds.has(input.fundId)) credit(state.partner, user, input.amount);
        state.funds.add(input.fundId);
        return ok({ label: PARTNER, assetId: HOME_ASSET, balance: String(state.partner.get(user)), asOf: new Date(state.t).toISOString() });
      }
      if (proc === 'transfers.toUser') {
        state.writes.push(`bank ${proc} ${user}`);
        assert.deepEqual(
          [user, input],
          [
            'user-b',
            {
              transferId: HOME_PARTNER_TRANSFER_ID,
              fromSpaceId: 'space-user-b',
              toUserId: 'user-a',
              amount: HOME_PARTNER_AMOUNT,
              note: HOME_PARTNER_NOTE,
            },
          ],
        );
        if (!state.sends.has(input.transferId)) {
          credit(state.partner, 'user-b', `-${input.amount}`);
          credit(state.partner, 'user-a', input.amount);
          state.sends.set(input.transferId, 'TEST-move-1');
          if (fileRow) state.inbox.push({ id: 'n-send', kind: TRANSFER_RECEIVED_KIND, params: { transferId: input.transferId, amount: input.amount } });
        }
        return ok({
          ledgerTxId: postedByLedger ? 'ledger-tx-1' : null,
          partnerMove: postedByLedger ? null : { id: state.sends.get(input.transferId), label: PARTNER },
          amount: input.amount,
          note: input.note,
          reference: null,
          requestId: null,
        });
      }
      return base.mutate(mod, proc, input, token);
    },
    async query(mod, proc, input, token) {
      if (proc !== 'spaces.list') return base.query(mod, proc, input, token);
      const user = who[token];
      const amount = state.partner.get(user);
      if (amount === undefined) return ok([]);
      const heldAt = state.custody.get(user) === 'off' ? { label: PARTNER, asOf: new Date(state.t).toISOString() } : null;
      return ok([{ id: `space-${user}`, kind: 'primary', assetId: HOME_ASSET, balance: String(amount), heldAt }]);
    },
  };
  return { home, state };
}

test('launch model: apply makes a TEST wallet, TEST venue funds, a TEST partner balance, a TEST notice and one inbox row, and no deposit', async () => {
  const { home, state } = launchStack();
  assert.deepEqual(await applyHome(home), [
    `home wallet: TEST wallet ${WALLET} for local_test_founder_a, made (its TEST key is in ${HOME_WALLET_FILE}, never shown); on the TEST chain: funded with TEST ETH and TEST USD`,
    `home venue: ${HOME_VENUE_AMOUNT} ${HOME_VENUE_ASSET} to ${WALLET} at ${VENUE.displayName} (TEST), credited; the venue reports ${HOME_VENUE_AMOUNT} ${HOME_VENUE_ASSET}`,
    `home partner: ${HOME_PARTNER_AMOUNT} ${HOME_ASSET} from local_test_founder_b to local_test_founder_a at ${PARTNER} (TEST), partner move TEST-move-1; the partner reports ${HOME_PARTNER_AMOUNT} ${HOME_ASSET}`,
    `home notice: ${HOME_NOTICE_TITLE} published`,
    'home inbox: 1 transfer-received row for local_test_founder_a',
  ]);
  // Nothing of the custodial layer ran: no deposit address was asked for and no chain transfer was delivered to svc-pay.
  assert.equal(state.deliveries, 0);
  assert.equal(state.deposits.size, 0);
  assert.ok(!state.writes.includes('bank deposits.address'));
  assert.equal(state.venue.get(WALLET), 500n);
  assert.deepEqual([state.partner.get('user-a'), state.partner.get('user-b')], [25n, 0n]);
  assert.equal(state.notices.length, 1);
});

test('launch model: a second apply credits, pays in, sends, files and publishes nothing new', async () => {
  const { home, state } = launchStack();
  await applyHome(home);
  const again = await applyHome(home);
  assert.match(again[0], /, kept \(.*\); on the TEST chain: already funded$/);
  assert.match(again[1], new RegExp(`, already credited; the venue reports ${HOME_VENUE_AMOUNT} ${HOME_VENUE_ASSET}$`));
  assert.match(again[2], new RegExp(`partner move TEST-move-1; the partner reports ${HOME_PARTNER_AMOUNT} ${HOME_ASSET}$`));
  assert.equal(again[3], `home notice: ${HOME_NOTICE_TITLE} skipped`);
  assert.equal(state.venue.get(WALLET), 500n);
  assert.deepEqual([state.partner.get('user-a'), state.partner.get('user-b')], [25n, 0n]);
  assert.deepEqual([state.funds.size, state.sends.size, state.inbox.length, state.drafts.length], [1, 1, 1, 1]);
});

test('launch model: a venue behind the door that is not TEST, not answering or not the stack’s own is refused before anything is made', async () => {
  for (const [options, message] of [
    [{ door: { test: false } }, /refusing: the venue behind the user-venue door is not a TEST venue/],
    [{ door: { available: false, refusal: { code: 'venue.down', detail: '' } } }, /the user-venue door is on and its venue is not answering \(venue\.down\)/],
    [{ venueId: 'some-other-venue' }, /refusing: the stack's TEST venue is not the venue behind the user-venue door \(test-venue-sim\)/],
  ]) {
    const { home, state } = launchStack(options);
    await assert.rejects(applyHome(home), message);
    assert.deepEqual(state.writes, []);
    assert.deepEqual(state.drafts, []);
  }
});

test('launch model: a send the ledger posted, or no inbox row for it, fails by name before any notice is drafted', async () => {
  const posted = launchStack({ postedByLedger: true });
  await assert.rejects(applyHome(posted.home), /the TEST home send was not moved by the TEST partner bank/);
  assert.deepEqual(posted.state.drafts, []);
  const silent = launchStack({ fileRow: false });
  await assert.rejects(applyHome(silent.home), { message: "founder a's inbox has 0 transfer-received rows for the TEST home send, not 1" });
  assert.deepEqual(silent.state.drafts, []);
});

test('launch model: status reads each source back without writing, before and after apply', async () => {
  const { home, state } = launchStack();
  assert.deepEqual(await homeStatus(home), [
    'home:',
    '  wallet  none  local_test_founder_a',
    '  venue  none',
    '  partner  none  local_test_founder_a',
    '  notice  none',
    '  inbox  0 transfer-received rows  local_test_founder_a',
  ]);
  assert.deepEqual(state.writes, []);
  await applyHome(home);
  state.writes = [];
  assert.deepEqual(await homeStatus(home), [
    'home:',
    `  wallet  TEST wallet ${WALLET}  local_test_founder_a`,
    `  venue  ${HOME_VENUE_AMOUNT} ${HOME_VENUE_ASSET} at ${VENUE.displayName}`,
    `  partner  ${HOME_PARTNER_AMOUNT} ${HOME_ASSET} at ${PARTNER}  local_test_founder_a`,
    `  notice  ${HOME_NOTICE_TITLE}  published`,
    '  inbox  1 transfer-received row  local_test_founder_a',
  ]);
  assert.deepEqual(state.writes, []);
});

test('with the door off, a stack wired for the launch model still seeds the custodial TEST deposit and nothing else', async () => {
  const { home, state } = launchStack({ door: { enabled: false } });
  const lines = await applyHome(home);
  assert.equal(lines[0], `home deposit: ${HOME_DEPOSIT_AMOUNT} ${HOME_ASSET} on TEST ${HOME_NETWORK} to local_test_founder_a, credited`);
  assert.deepEqual(state.writes, ['bank deposits.address']);
  assert.equal(state.wallet, null);
});
