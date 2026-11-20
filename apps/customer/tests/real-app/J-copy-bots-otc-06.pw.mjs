// World: book, gates, restart
import { createHash, randomUUID } from 'node:crypto';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { api, journeyState, restartService, signOutBrowser, toUnits } from './stack.mjs';
import { fundedTrader, signIn } from './desk.mjs';
import { copiedOrders, followOnScreen, leadFill, listLeader, openFollow, userIdOf } from './copy.mjs';
import { confirmStepUp, testPasskey } from './p2p.mjs';
import { ownSpotMarket } from './own-market.mjs';
import {
  TEST_VENUE,
  doorOk,
  otherTraderRun,
  signPrepared,
  testDeposit,
  testVenue,
  otherTraderKey,
  venueAccount,
  venueForThisFile,
  venueInfo,
  venueRecord,
  walletDoorAct,
} from './venue.mjs';

// J-copy-bots-otc-06, in the running app (docs/roadmap/journeys.json): see what copying costs me and what a lead earns.
// One test per step, titled "J-copy-bots-otc-06 #<n>", run in order. #1 makes the journey's start, twice over:
// - on the TEST book, a TEST leader listed by the stack's TEST founder, a verified follower who follows it on screen, and
//   two copied buys (the leader's own fills), which #2 reads as one copied position with two fills;
// - on the venue, where our builder fee is earned: a second TEST leader who trades a TEST spot market of this file's own
//   (ownSpotMarket, so no other journey's resting orders meet these) on their own account on the stack's TEST venue, and the same follower copying them onto their own agent account (a venue
//   sub-account under their own TEST wallet). The leader buys and then sells; the copy of the sell is a venue fill that
//   carries our builder fee (the venue charges none on a spot buy). svc-trade records the leader's share of that fee once
//   its Earn is booked, sets it aside when the venue pays us the fee (the TEST venue's own claim control stands in for
//   our claim) and owes it to the leader, all on its own (src/copy/venue-fee-share.ts). The share rate is the stack's
//   labelled TEST copy fee share.
// #1 reads the follower's money activity against the venue's own record of the fill and the ledger's own record of the
// share; #3 reads the venue leader's earnings panel against the ledger. #2 #4 #5 #6 run on the TEST-book start.
// svc-trade's user-venue door is on for this file (venueForThisFile), so trade restarts once before and once after it.
const J = 'J-copy-bots-otc-06';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const SCALE = 10n ** 18n;
/** A scaled amount as the service writes it: no trailing zeros, no grouping. */
function fromUnits(units) {
  const whole = units / SCALE;
  const frac = (units % SCALE).toString().padStart(18, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}
/** Quote paid over base filled, rounded half up at 18 places, as svc-trade divides. */
function averageEntry(fills) {
  const qty = fills.reduce((a, f) => a + toUnits(String(f.amount)), 0n);
  const cost = fills.reduce((a, f) => a + toUnits(String(f.cost)), 0n);
  const scaled = cost * SCALE;
  let q = scaled / qty;
  if ((scaled % qty) * 2n >= qty) q += 1n;
  return fromUnits(q);
}
const ungroup = (text) => text.replace(/,/g, '').trim();
/** The leader's earnings as the service answers them, for the leader's own key. */
async function leadEarnings(who) {
  const res = await (await api(who)).get(`/api/trade/trpc/copy.leadEarnings?input=${encodeURIComponent(JSON.stringify({ limit: 50 }))}`);
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body.result.data;
}
/** A tRPC refusal's own code. */
const refusalCode = (body) => body?.error?.data?.cause?.code ?? JSON.stringify(body).slice(0, 300);

test.describe.configure({ mode: 'default' });
// An action on a part that never appears fails in 15 s, not at the test's time limit.
test.use({ actionTimeout: 15_000 });
venueForThisFile(test);

function state(key) {
  const value = run.read()[key];
  if (!value) throw new Error(`${J}: an earlier step made no ${key}, so this step has nothing to act on`);
  return value;
}

// ── the venue start (#1): a copy on the follower's own agent account, where our builder fee is earned ───────────────

// The other side of every venue trade here: a TEST trader resting on this file's own market at one price.
const MAKER = `${J} maker`;
const VPRICE = '100';
const STEP_UP_AGENT = { scope: 'trade.step_up.venue.agentAccount', purpose: 'venue.agentAccount' };
const walletOf = (name) => privateKeyToAccount(keccak256(toHex(`intafaced TEST venue journey trader ${J} ${name} ${run.read().tag}`)));
/** Our builder fee rides on every door order the venue charges it on: the wallet approves it once on the account. */
async function approveBuilder(session, key, subAccount, tag, symbol) {
  const status = doorOk(await session.get('/api/v1/venue/status'));
  expect(status.builder, 'the TEST builder fee is set on the door').toBeTruthy();
  const cap = (await testVenue('/markets', { account: null })).body.value.find((m) => m.symbol === symbol)?.builderFeeCapBps;
  expect(cap, `${symbol}'s builder-fee cap as the venue publishes it`).toMatchObject({ known: true });
  await walletDoorAct(session, key, {
    subAccount,
    intent: { kind: 'approve_builder_fee', builder: status.builder.address, maxFeeBps: cap.value },
    actionKey: `approve:${tag}:builder`,
  });
  return status.builder.address;
}
/** The TEST venue's own record for an account, read directly by the venue fixture's read. */
const onVenue = async (path, owner, subAccount = null, extra = {}) => (await venueRecord(owner, path, extra, TEST_VENUE, subAccount)).value;
/** The leader trades once on their own venue account, signed by their own wallet: an IOC that meets the TEST maker. */
async function venueLeadOrder(leader, key, symbol, side, amount, n) {
  await walletDoorAct(await api(leader), key, {
    intent: {
      kind: 'place_order',
      symbol,
      side,
      type: 'limit',
      amount,
      price: VPRICE,
      timeInForce: 'IOC',
      reduceOnly: false,
      clientOrderKey: `order:${J}:lead:${run.read().tag}:${n}`,
      builderFee: null,
    },
  });
}
/** The TEST maker rests one order on this file's own market at the one price. */
async function makerOrder(symbol, side, amount, price = VPRICE) {
  const answer = await otherTraderRun(MAKER, {
    kind: 'place_order',
    symbol,
    side,
    type: 'limit',
    amount,
    price,
    timeInForce: 'GTC',
    reduceOnly: false,
    clientOrderKey: `order:${J}:maker:${run.read().tag}:${side}:${price}`,
    builderFee: null,
  });
  expect(answer, JSON.stringify(answer).slice(0, 300)).toMatchObject({ accepted: true });
}
/** The follower's copied venue fills and their fees, as svc-trade answers its own record `copy.myCopyFees`. */
async function myCopyFees(who) {
  const res = await (await api(who)).get(`/api/trade/trpc/copy.myCopyFees?input=${encodeURIComponent(JSON.stringify({ limit: 100 }))}`);
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body.result.data;
}
/** svc-trade's copied positions of a follow. */
async function copiedPositions(who, followId) {
  const res = await (await api(who)).get(`/api/trade/trpc/copy.copiedPositions?input=${encodeURIComponent(JSON.stringify({ followId }))}`);
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body.result.data.positions;
}

let staff;
/** The stack's TEST founders' sessions, for svc-ledger's operator reads (founder a, admin:treasury). */
async function founders() {
  staff ??= (async () => {
    const gates = await import('../../../../tooling/scripts/local-test-gates.mjs');
    const ctx = await gates.makeContext({ log: () => {} });
    return { ctx, sessions: await gates.approverSessions(ctx) };
  })();
  return staff;
}
/** One svc-ledger operator read, as founder a. */
async function ledgerRead(path) {
  const { ctx, sessions } = await founders();
  const res = await fetch(`${ctx.url('ledger')}${path}`, { headers: { authorization: `Bearer ${await sessions.a.treasuryToken()}` } });
  const text = await res.text();
  expect(res.status, text.slice(0, 300)).toBe(200);
  return JSON.parse(text);
}
/** The transaction svc-ledger itself holds under one business key. */
const ledgerTrace = (key) => ledgerRead(`/operator/trace?businessKey=${encodeURIComponent(key)}`);
/** What the ledger says INTAFACED owes a lead, in one asset: the lead's own owed account, from svc-ledger's account read. */
async function ledgerOwedTo(leaderId, asset) {
  const page = await ledgerRead(`/operator/accounts?prefix=${encodeURIComponent(`module:trade:fee-share-owed:lead-trader.${leaderId}`)}`);
  const rows = page.accounts.filter((r) => r.assetId === asset);
  expect(rows.length, `the ledger has one owed account of the lead in ${asset}`).toBeLessThanOrEqual(1);
  return { accountId: rows[0]?.accountId ?? null, balance: toUnits(rows[0]?.balance ?? '0') };
}

/** The venue start (above); kept in this run's state. */
async function venueStart(page) {
  const { tag } = run.read();
  const follower = state('follower');
  const leaderKey = walletOf('leader');
  const followerKey = walletOf('follower');
  const vLeader = await fundedTrader(page, 'jcv6', '10');
  const vLeaderName = `Journey Costs Venue ${tag}`;
  // A TEST spot market of this file's own, and a TEST maker funded on it in its coin and in USDC.
  const { symbol, base } = await ownSpotMarket(J, 'JC6', 'V');
  // An assistant trades only the markets the stack lists; this restart adds this file's own (put back after the start).
  await restartService('trade', { LOCAL_STACK_USER_VENUE: 'on', LOCAL_STACK_AGENT_MARKETS_ADD: symbol });
  for (const [asset, amount] of [
    [base, '10'],
    ['USDC', '1000'],
  ]) {
    const funded = await testVenue('/test/deposit', {
      account: await venueAccount(otherTraderKey(MAKER).address),
      asset,
      amount,
      depositRef: `seed:${MAKER}:${symbol}:${asset}`,
    });
    expect(funded.status, JSON.stringify(funded.body)).toBe(200);
  }
  const vLeaderRef = await listLeader(vLeader, vLeaderName, { assets: [symbol] });
  const { chainId } = await venueInfo();
  const ref = (who) => `${chainId}:0x${createHash('sha256').update(`${J}:${tag}:${who}`).digest('hex')}:0`;
  await testDeposit(leaderKey.address.toLowerCase(), 'USDC', '1000', ref('leader'));
  await testDeposit(followerKey.address.toLowerCase(), 'USDC', '500', ref('follower'));
  const builder = await approveBuilder(await api(vLeader), leaderKey, null, `${J}:${tag}:leader`, symbol);

  // The follower's agent account: cap TEST 200 USDC, funded 150, with step-up; the wallet signs the open, the agent
  // permission and the move in (J-agents-21 #3's own path, as J-copy-bots-otc-03 opens one).
  const session = await api(follower);
  const passkey = await testPasskey(session);
  const owner = followerKey.address.toLowerCase();
  const accountId = randomUUID();
  const fields = { accountId, owner, asset: 'USDC', cap: '200', fund: '150' };
  const stepUpApprovalId = await confirmStepUp(session, passkey, { ...STEP_UP_AGENT, target: accountId, amount: '150', fields });
  let view = doorOk(await session.post('/api/v1/venue/agent-accounts', { ...fields, stepUpApprovalId }));
  for (let i = 0; view.next && i < 5; i += 1) {
    view = doorOk(
      await session.post(`/api/v1/venue/agent-accounts/${accountId}/submit`, {
        actionKey: view.next.actionKey,
        signature: await signPrepared(followerKey, view.next.prepared),
      }),
    );
  }
  expect(view.status).toBe('open');
  await approveBuilder(session, followerKey, view.subAccount, `${J}:${tag}:sub`, symbol);
  const followed = doorOk(
    await session.post('/api/trade/trpc/copy.follow', {
      leaderRef: vLeaderRef,
      region: 'DE',
      permittedMarkets: [symbol],
      maxNotionalPerOrder: '50',
      maxAggregateExposure: '150',
      expiresAt: new Date(Date.now() + 7 * 24 * 3600_000).toISOString(),
      clientRequestId: `jc6-venue:${tag}`,
      agentAccountId: accountId,
    }),
  );
  const vFollowId = followed.result.data.followId;
  doorOk(await session.post('/api/trade/trpc/copy.grantSessionKey', { followId: vFollowId }));
  run.write({ vSymbol: symbol, vLeader, vLeaderName, vLeaderRef, vFollowId, vOwner: owner, vSub: view.subAccount, builder });

  // The leader buys, and the driver copies the leader's own amount onto the sub-account (a spot buy: no builder fee).
  // The maker's ask holds exactly the two buys.
  // An assistant's order is judged against the book's mid, so the book holds both sides: a small bid under the ask.
  await makerOrder(symbol, 'sell', '0.6');
  await makerOrder(symbol, 'buy', '0.02', '99');
  await venueLeadOrder(vLeader, leaderKey, symbol, 'buy', '0.3', 1);
  await expect
    .poll(async () => (await copiedPositions(follower, vFollowId)).filter((p) => toUnits(p.open) > 0n).length, {
      timeout: 60_000,
      message: 'the copy driver never copied the lead buy onto the agent sub-account',
    })
    .toBe(1);
  // The leader sells, and the driver copies the sell: a venue fill of ours that carries our builder fee.
  const before = await onVenue('/balances', owner, view.subAccount);
  await makerOrder(symbol, 'buy', '1');
  // The two buys took the whole ask; a small ask over the bid gives the copied sell a mid to be judged by.
  await makerOrder(symbol, 'sell', '0.02', '101');
  await venueLeadOrder(vLeader, leaderKey, symbol, 'sell', '0.2', 2);
  const copiedSell = async () => (await myCopyFees(follower)).rows.find((r) => r.followId === vFollowId && r.side === 'sell');
  let sell;
  await expect
    .poll(async () => Boolean((sell = await copiedSell())), { timeout: 60_000, message: 'the copied sell never filled' })
    .toBe(true);
  run.write({ vSellFill: sell.fillId, vBalancesBefore: before });

  // svc-trade records the leader's share once the builder-fee poster has booked our fee earned on the fill: owed once
  // the venue pays us the fee.
  await expect
    .poll(async () => (await copiedSell()).feeShare.state, { timeout: 60_000, message: 'the leader share was never recorded' })
    .toBe('waiting_collection');
  // The venue pays us our builder fees (the TEST venue's claim control, standing in for our claim); svc-trade's collect
  // books the claim, sets the leader's share aside from it and owes it to the leader, with no one asking.
  const claimed = await testVenue('/test/builder-claim', { builder });
  expect(claimed.status, JSON.stringify(claimed.body).slice(0, 300)).toBe(200);
  await expect
    .poll(async () => (await copiedSell()).feeShare.state, { timeout: 60_000, message: 'the leader share was never owed' })
    .toBe('owed');
}

test(`${J} #1 as a follower opens activity after a copied fill: one row for the venue fill with the venue's fee and our builder fee, each named with its source, and the lead's share paid by INTAFACED; no profit share`, async ({
  page,
}) => {
  test.setTimeout(600_000);
  const tag = Date.now().toString(36);
  const leader = await fundedTrader(page, 'jcl6', '2000');
  const leaderName = `Journey Costs ${tag}`;
  const leaderRef = await listLeader(leader, leaderName);
  const follower = await fundedTrader(page, 'jcf6', '1000');
  run.reset({ tag, leader, leaderName, leaderRef, follower });
  // The TEST-book start #2 reads: two copied buys of the leader's own fills.
  await signIn(page, follower);
  await followOnScreen(page, follower, leaderRef, { perOrder: '50', total: '300', fixed: '20' });
  await leadFill(leader, 'buy', '0.001', `${J}-1-a-${tag}`);
  await leadFill(leader, 'buy', '0.001', `${J}-1-b-${tag}`);
  await expect(async () => {
    await expect(copiedOrders(await openFollow(page, leaderRef))).toHaveCount(2, { timeout: 2_000 });
  }).toPass({ timeout: 60_000 });
  // The venue start, where the copied fill carries our builder fee.
  try {
    await venueStart(page);
  } finally {
    await restartService('trade', { LOCAL_STACK_USER_VENUE: 'on', LOCAL_STACK_AGENT_MARKETS_ADD: null });
  }
  const { vSymbol, vLeader, vLeaderName, vOwner, vSub, vSellFill, vBalancesBefore } = run.read();
  const vLeaderId = await userIdOf(vLeader);

  // The fill as the venue itself reports it on the follower's own sub-account.
  const fill = (await onVenue('/fills', vOwner, vSub, { since: new Date(0).toISOString() })).find((f) => f.fillId === vSellFill);
  expect(fill, 'the venue reports the copied fill on the sub-account').toBeTruthy();
  expect(toUnits(fill.builderFee)).toBeGreaterThan(0n);
  // The share as svc-trade recorded it: the owner's TEST rate (the leader's own earnings say it) on our builder fee.
  const earnings = await leadEarnings(vLeader);
  const bps = BigInt(earnings.leaderShareBps);
  const share = (toUnits(fill.builderFee) * bps) / 10_000n;
  const fees = await myCopyFees(follower);
  const row = fees.rows.find((r) => r.fillId === vSellFill);
  expect(row.feeShare).toMatchObject({ state: 'owed', share: { asset: fill.feeAsset } });
  expect(toUnits(row.feeShare.share.amount)).toBe(share);

  // The ledger's own record: owed by INTAFACED to the lead once, under the fill's key, our own accounts only.
  const trace = await ledgerTrace(row.feeShare.ledgerKey);
  expect(trace).toMatchObject({ found: true, module: 'trade', reason: 'trade.fee_share.owed' });
  expect(trace.postings).toHaveLength(2);
  for (const p of trace.postings) {
    expect(p.assetId).toBe(fill.feeAsset);
    expect(toUnits(p.amount)).toBe(share);
  }
  const owedTo = await ledgerOwedTo(vLeaderId, fill.feeAsset);
  expect(trace.postings.find((p) => p.direction === 'debit')?.accountId).toBe(owedTo.accountId);
  // Never charged to the follower on top: the sub-account was moved by exactly the fill, the venue's fee and our builder
  // fee, as the venue reports them, and nothing more.
  const after = await onVenue('/balances', vOwner, vSub);
  const usdc = (rows) => toUnits(rows.find((b) => b.asset === 'USDC')?.total ?? '0');
  const proceeds = (toUnits(fill.amount) * toUnits(fill.price)) / 10n ** 18n;
  expect(usdc(after) - usdc(vBalancesBefore)).toBe(proceeds - toUnits(fill.venueFee) - toUnits(fill.builderFee));

  // The follower's money activity: one row for that venue fill.
  await signIn(page, follower);
  await page.goto('/money/activity');
  const copied = page.getByRole('table', { name: 'Copied trades', exact: true });
  const rows = copied.getByRole('row').filter({ hasText: `Fill ${vSellFill}` });
  await expect(rows).toHaveCount(1);
  const shown = rows.first();
  const units = async (testId) => toUnits(ungroup((await shown.getByTestId(testId).innerText()).match(/[\d.,]+/)[0]));
  await expect(shown).toContainText(`Sold`);
  await expect(shown).toContainText(vSymbol);
  await expect(shown).toContainText(`Copying ${vLeaderName}`);
  // The venue's fee and our builder fee, each as the venue reports it and named with its source.
  const venueName = (await venueInfo()).displayName;
  await expect(shown.getByTestId('money-copied-fill__venue-fee')).toContainText(`From ${venueName}, as it reports it`);
  await expect(shown.getByTestId('money-copied-fill__venue-fee')).toContainText(fill.feeAsset);
  expect(await units('money-copied-fill__venue-fee')).toBe(toUnits(fill.venueFee));
  await expect(shown.getByTestId('money-copied-fill__builder-fee')).toContainText('From INTAFACED, charged on the venue');
  await expect(shown.getByTestId('money-copied-fill__builder-fee')).toContainText(fill.feeAsset);
  expect(await units('money-copied-fill__builder-fee')).toBe(toUnits(fill.builderFee));
  // The lead's share of our builder fee: the fill, the lead, the asset and the amount; paid by INTAFACED, not charged.
  const shareCell = shown.getByTestId('money-copied-fill__share');
  await expect(shareCell).toContainText(`${fill.feeAsset} to ${vLeaderName}`);
  expect(await units('money-copied-fill__share')).toBe(share);
  await expect(shareCell).toContainText('Owed by INTAFACED in our ledger');
  await expect(shareCell).toContainText('Paid by INTAFACED. Not charged to you.');
  await expect(shown.getByTestId('money-copied-fill__id')).toHaveText(`Fill ${vSellFill}`);
  // The copied buy is its own row: a spot buy carries no builder fee, so nothing is shared on it.
  const buy = fees.rows.find((r) => r.followId === run.read().vFollowId && r.side === 'buy');
  expect(buy.feeShare).toEqual({ state: 'none' });
  await expect(copied.getByRole('row').filter({ hasText: `Fill ${buy.fillId}` })).toContainText(
    'No builder fee on this fill, so nothing is shared',
  );
  await expect(page.getByText(/profit.share/i)).toHaveCount(0);
});

test(`${J} #2 opens a copied position with two fills and no funding data: average entry from the two fills; funding "Not set"`, async ({
  page,
}) => {
  const follower = state('follower');
  // The follower's own fills, as the spot API reports them: the follower is new, so these are the two copied buys.
  const { body } = await (await api(follower)).get('/api/v1/account/trades?symbol=BTC%2FUSDT&limit=100');
  const fills = (Array.isArray(body) ? body : (body.trades ?? [])).filter((f) => f.side === 'buy');
  expect(fills, JSON.stringify(body).slice(0, 300)).toHaveLength(2);
  const expected = averageEntry(fills);

  await signIn(page, follower);
  const detail = await openFollow(page, state('leaderRef'));
  await detail.getByRole('tab', { name: 'Positions' }).click();
  const position = detail.getByRole('table', { name: 'Copied position by market' });
  const row = position.locator('tbody tr').filter({ hasText: 'BTC/USDT' });
  await expect(row).toHaveCount(1);
  const header = await position.locator('thead th').allInnerTexts();
  const cell = (name) => row.locator('td').nth(header.findIndex((h) => h.trim() === name));
  await expect(cell('Fills')).toHaveText('2');
  expect(ungroup(await cell('Average entry').innerText())).toBe(expected);
  await expect(cell('Funding')).toHaveText('Not set');
});

test(`${J} #3 as a lead opens the earnings panel: the profit-share refusal text and the fee-share facts only`, async ({ page }) => {
  const leader = state('vLeader');
  const leaderId = await userIdOf(leader);
  const earnings = await leadEarnings(leader);
  await signIn(page, leader);
  await page.goto('/trade/copy?tab=lead');
  const panel = page.getByRole('region', { name: 'Your earnings' });
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('Leaders are paid a share of the trading fee only, never a share of profit.');
  // The fee-share facts: what was earned on #1's copied venue fill, as a total and one history row per recorded share,
  // each with its fill, owed by INTAFACED in our ledger.
  const usdc = earnings.totals.find((x) => x.assetId === 'USDC');
  expect(usdc, `${J}: no fee share is recorded for the lead's copied fills`).toBeTruthy();
  expect(toUnits(usdc.amount)).toBeGreaterThan(0n);
  const rows = earnings.items.filter((x) => x.assetId === 'USDC');
  expect(rows.reduce((a, x) => a + toUnits(x.amount), 0n)).toBe(toUnits(usdc.amount));
  expect(rows.map((x) => x.venueFillId)).toContain(state('vSellFill'));
  // The ledger rows reconcile to the fee-share history: each row's own ledger post is its amount, and what the ledger says
  // INTAFACED owes the lead is the history's total.
  for (const x of rows) {
    const trace = await ledgerTrace(x.ledgerKey);
    expect(trace).toMatchObject({ found: true, reason: 'trade.fee_share.owed' });
    expect(toUnits(trace.postings.find((p) => p.direction === 'debit').amount)).toBe(toUnits(x.amount));
  }
  expect((await ledgerOwedTo(leaderId, 'USDC')).balance).toBe(toUnits(usdc.amount));
  expect(ungroup(await panel.innerText())).toMatch(new RegExp(`Fee share earned\\s*${usdc.amount.replace(/[.]/g, '\\.')} USDC`));
  await expect(panel).toContainText('Leader’s share of the fee');
  await expect(panel).toContainText(/Profit share\s*Not offered/);
  const history = panel.getByRole('table', { name: 'Fee share history' }).locator('tbody tr:not([data-slot="table-empty-row"])');
  await expect(history).toHaveCount(earnings.items.length);
  const ours = history.filter({ hasText: `Fill ${state('vSellFill')}` });
  await expect(ours).toHaveCount(1);
  await expect(ours).toContainText('USDC');
  await expect(ours).toContainText('Owed by INTAFACED');
  // Only fee-share facts: no profit, loss, return or unrealised figure anywhere in the panel.
  await expect(panel).not.toContainText(/P&L|PnL|ROI|unreali[sz]ed|realised profit|return/i);
});

test(`${J} #4 tries to set a pre-deduction of profit: refused as profit share forbidden, and no fee row is written`, async ({ page }) => {
  const leader = state('leader');
  const before = await leadEarnings(leader);
  await signIn(page, leader);
  await page.goto('/trade/copy?tab=lead');
  const panel = page.getByRole('region', { name: 'Your earnings' });
  await panel.getByLabel('Profit share, %').fill('10');
  await panel.getByRole('button', { name: 'Set a profit share' }).click();
  await expect(panel.getByRole('alert')).toContainText('Reference trade.copy_pnl_fee_forbidden');
  // The same refusal straight from the service, and nothing written: the fee-share rows are as they were.
  const direct = await (await api(leader)).post('/api/trade/trpc/copy.setProfitShare', { percent: '10' });
  expect(direct.status).toBe(403);
  expect(refusalCode(direct.body)).toBe('trade.copy_pnl_fee_forbidden');
  const after = await leadEarnings(leader);
  expect(after.items).toEqual(before.items);
  expect(after.totals).toEqual(before.totals);
});

test(`${J} #5 opens the level view: the level and "Maximum ratio: not set by the platform"; setting a ratio is refused`, async ({
  page,
}) => {
  const leader = state('leader');
  await signIn(page, leader);
  await page.goto('/trade/copy?tab=lead');
  const level = page.getByRole('region', { name: 'Your level' });
  // The owner has published no level thresholds, so the level is shown as not set, never as a made-up tier.
  await expect(level).toContainText(/Level\s*Not set: the platform has not published level thresholds/);
  await expect(level).toContainText(state('leaderRef'));
  await expect(level).toContainText('Maximum ratio: not set by the platform');
  await level.getByLabel('Maximum ratio').fill('0.5');
  await level.getByRole('button', { name: 'Set a maximum ratio' }).click();
  await expect(level.getByRole('alert')).toContainText('Reference trade.copy_pnl_fee_forbidden');
  // Any caller: the leader, and a follower who is no lead at all.
  for (const who of [leader, state('follower')]) {
    const set = await (await api(who)).post('/api/trade/trpc/copy.setMaxRatio', { ratio: '0.5' });
    expect(set.status).toBe(403);
    expect(refusalCode(set.body)).toBe('trade.copy_pnl_fee_forbidden');
  }
  const read = await (await api(leader)).get('/api/trade/trpc/copy.leadLevel');
  expect(read.body.result.data).toMatchObject({ level: null, maxRatio: null });
});

test(`${J} #6 looks for a leaderboard: the ranking categories refused, and only the stated empty state shows`, async ({ page }) => {
  const follower = state('follower');
  for (const ask of [{ category: 'top_return' }, { category: 'most_copied' }, { trending: true }]) {
    const res = await (
      await api(follower)
    ).get(`/api/trade/trpc/copy.listLeaders?input=${encodeURIComponent(JSON.stringify({ limit: 50, ...ask }))}`);
    expect(res.status, JSON.stringify(ask)).toBe(403);
    expect(refusalCode(res.body)).toBe('trade.copy_ranking_forbidden');
  }
  await signIn(page, follower);
  await page.goto('/trade/copy?tab=leaderboard');
  await expect(page.getByRole('heading', { name: 'Leaderboard' })).toBeVisible();
  await expect(page.getByText('Leaders are not ranked by returns here.')).toBeVisible();
  const categories = page.getByRole('list', { name: 'Ranked categories' }).getByRole('listitem');
  await expect(categories).toHaveCount(3);
  for (const item of await categories.all()) {
    await expect(item).toContainText('Refused');
    await expect(item).toContainText('Reference trade.copy_ranking_forbidden');
  }
  await expect(page.getByRole('table', { name: 'Leaderboard' })).toHaveCount(0);
  await expect(page.getByRole('grid', { name: 'Leaderboard' })).toHaveCount(0);
  await signOutBrowser(page.context());
});
