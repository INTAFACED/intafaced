// World: book, gates, restart
import { createHash, randomUUID } from 'node:crypto';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { api, journeyState, restartService, tool, toUnits } from './stack.mjs';
import { mailbox } from './test-mail.mjs';
import { fundedTrader, signIn } from './desk.mjs';
import { confirmStepUp, refusalCode, restorePasskey, testPasskey } from './p2p.mjs';
import {
  TEST_VENUE,
  doorOk,
  otherTraderKey,
  otherTraderRun,
  signPrepared,
  testDeposit,
  testVenue,
  venueAccount,
  venueForThisFile,
  venueInfo,
  venueRecord,
  walletDoorAct,
} from './venue.mjs';
import { ownSpotMarket } from './own-market.mjs';
import { copiedOrdersLoaded, followOnScreen, listLeader, openFollow } from './copy.mjs';

// J-copy-bots-otc-03, in the running app (docs/roadmap/journeys.json): pause, stop or leave a copy, close what I choose,
// and read why trades were skipped. One test per step, titled "J-copy-bots-otc-03 #<n>", run in order.
// Every trading step (#1, #2, #3, #4, #5, #7) runs on the stack's TEST venue on a fresh TEST spot market of this file's
// own (`ownSpotMarket`, so no other journey's resting orders meet these): the leader trades on their own venue account,
// signed by their own TEST wallet through our door, and the follower's follow copies onto their own agent account (a
// venue sub-account under their TEST wallet, with an agent permission that can trade and never withdraw). Every fill,
// open order and balance is read directly from the TEST venue through `venueRecord`.
// #1 starts the follow used by #1, #2, #5, #6 and #7 with three copied buys, so #2's lead close leaves a position open
// for #7 to keep on detach; #3 and #4 use a second venue follow (`vFollowId`) because #4's close-all detaches it.
// #5 tries a skipped venue fill again through the stack's LOCAL TEST rewind (`local-test-gates.mjs copy-rewind`): nothing
// in the running app sends a fill the copy driver has passed through it again.
// svc-trade's user-venue door is on for this file (venueForThisFile), so trade restarts once before and once after it.
const J = 'J-copy-bots-otc-03';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const STEP_UP_AGENT = { scope: 'trade.step_up.venue.agentAccount', purpose: 'venue.agentAccount' };
const ONE = 10n ** 18n;
const mulCeil = (a, b) => (a * b + ONE - 1n) / ONE;
const VASK = '101';
const VBID = '99';

test.describe.configure({ mode: 'default' });
// An action on a part that never appears fails in 15 s, not at the test's time limit.
test.use({ actionTimeout: 15_000 });
venueForThisFile(test);

function state(key) {
  const value = run.read()[key];
  if (!value) throw new Error(`${J}: an earlier step made no ${key}, so this step has nothing to act on`);
  return value;
}

const trpc = (proc, input) => `/api/trade/trpc/${proc}?input=${encodeURIComponent(JSON.stringify(input ?? {}))}`;
const walletOf = (name) => privateKeyToAccount(keccak256(toHex(`intafaced TEST venue journey trader ${J} ${name} ${run.read().tag}`)));

/** Presses a follow action and confirms it in its dialog. */
async function act(page, detail, button) {
  await detail.getByRole('button', { name: button, exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: button, exact: true }).click();
}

/** A tRPC query of svc-trade's, as `who`: the result's data. */
async function trpcQuery(who, proc, input) {
  const res = await (await api(who)).get(trpc(proc, input));
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body.result.data;
}

/** The follow as svc-trade reads it back to its owner. */
async function myFollow(who, followId) {
  const follow = (await trpcQuery(who, 'copy.listMyFollows', { limit: 100 })).find((f) => f.followId === followId);
  expect(follow, `copy.listMyFollows has no follow ${followId}`).toBeTruthy();
  return follow;
}

/** svc-trade's copied positions of the follow, newest first (the order the screen lists them in). */
async function copiedPositions(who, followId) {
  return (await trpcQuery(who, 'copy.copiedPositions', { followId })).positions;
}

const isOpen = (p) => toUnits(p.open) > 0n;
const capped = (id) => (id.length <= 64 ? id : createHash('sha256').update(id).digest('hex').slice(0, 64));
const sameUnits = (a, b) => toUnits(String(a)) === toUnits(String(b));

/** The TEST venue's own record for an account, sub-account or main, read directly by the venue fixture's read. */
async function onVenue(path, owner, subAccount = null, extra = {}) {
  return (await venueRecord(owner, path, extra, TEST_VENUE, subAccount)).value;
}

/** The venue's client order id for one of our business keys (venue-contracts `venueClientOrderId`). */
const cloidOf = async (key) =>
  `0x${createHash('sha256')
    .update(`${(await venueInfo()).id}\u0000${key}`)
    .digest('hex')
    .slice(0, 32)}`;

/** A leader's venue fill id in svc-trade's canonical shape (`venue:<owner>:<ms>:<fillId>`). */
const venueFillIdOf = (owner, f) => `venue:${owner.toLowerCase()}:${new Date(f.filledAt).getTime()}:${f.fillId}`;

/** Our builder fee rides on every door order: the wallet approves it once on the account, up to the venue's cap. */
async function approveBuilder(session, key, subAccount, tag, symbol) {
  const status = doorOk(await session.get('/api/v1/venue/status'));
  if (!status.builder) return;
  const cap = (await testVenue('/markets', { account: null })).body.value.find((m) => m.symbol === symbol)?.builderFeeCapBps;
  expect(cap, `${symbol}'s builder-fee cap as the venue publishes it`).toMatchObject({ known: true });
  await walletDoorAct(session, key, {
    subAccount,
    intent: { kind: 'approve_builder_fee', builder: status.builder.address, maxFeeBps: cap.value },
    actionKey: `approve:${tag}:builder`,
  });
}

/** This file's own market's lot size as the TEST venue publishes it. */
async function venueLot(symbol) {
  const market = (await testVenue('/markets', { account: null })).body.value.find((m) => m.symbol === symbol);
  expect(market, `${symbol} in TEST venue markets`).toBeTruthy();
  return toUnits(market.lotSize);
}

/** Asset total on a venue balances list, as a scaled bigint. */
const assetTotal = (balances, asset) => toUnits(balances.find((b) => b.asset === asset)?.total ?? '0');

/** Strip volatile `asOf` timestamps so before/after snapshots compare every real figure. */
const stableOrders = (orders) =>
  [...orders]
    .sort((a, b) => (a.orderId < b.orderId ? -1 : 1))
    .map(({ venue, ...o }) => ({ ...o, ...(venue ? { venue: { ...venue, asOf: '' } } : {}) }));
const stablePositions = (positions) =>
  positions.map(({ reportedBy, ...p }) => ({
    ...p,
    ...(reportedBy ? { reportedBy: { venue: reportedBy.venue, test: reportedBy.test } } : {}),
  }));

/**
 * Everything a pause, stop or leave must not touch on a venue follow: svc-trade's copied orders and positions, plus the
 * TEST venue's own fills, open orders and balances on the follower's agent sub-account and main account.
 */
async function venueSnapshot(who, followId, owner, subAccount) {
  const orders = (await trpcQuery(who, 'copy.followPositions', { followId })).positions;
  return {
    copiedOrders: stableOrders(orders),
    positions: stablePositions(await copiedPositions(who, followId)),
    subFills: await onVenue('/fills', owner, subAccount, { since: new Date(0).toISOString() }),
    subOpenOrders: await onVenue('/open-orders', owner, subAccount),
    subBalances: await onVenue('/balances', owner, subAccount),
    mainBalances: await onVenue('/balances', owner),
  };
}

/** The leader trades once on their own venue account, signed by their wallet: returns its canonical venue fill id(s). */
async function venueLeadOrder(leader, key, side, amount, n) {
  const symbol = state('vSymbol');
  const price = side === 'buy' ? VASK : VBID;
  const clientOrderKey = `order:${J}:lead:${run.read().tag}:${n}`;
  await walletDoorAct(await api(leader), key, {
    intent: {
      kind: 'place_order',
      symbol,
      side,
      type: 'limit',
      amount,
      price,
      timeInForce: 'IOC',
      reduceOnly: false,
      clientOrderKey,
      builderFee: null,
    },
  });
  const owner = key.address.toLowerCase();
  const cloid = await cloidOf(clientOrderKey);
  const fills = (await onVenue('/fills', owner, null, { since: new Date(0).toISOString() })).filter((f) => f.venueClientOrderId === cloid);
  expect(fills.length, `the leader's venue ${side} ${clientOrderKey} has no fills`).toBeGreaterThan(0);
  return fills.map((f) => venueFillIdOf(owner, f)).sort();
}

let marketWired = false;

/** Creates this file's own TEST spot market, seeds a two-sided book (bid 99 / ask 101) and adds it to trade's agent markets. */
async function ensureOwnMarket(tag) {
  if (run.read().vSymbol) {
    const symbol = state('vSymbol');
    if (!marketWired) {
      await restartService('trade', { LOCAL_STACK_USER_VENUE: 'on', LOCAL_STACK_AGENT_MARKETS_ADD: symbol });
      marketWired = true;
    }
    return { symbol, base: state('vBase') };
  }
  const { symbol, base } = await ownSpotMarket(J, 'CO3', 'V');
  await restartService('trade', { LOCAL_STACK_USER_VENUE: 'on', LOCAL_STACK_AGENT_MARKETS_ADD: symbol });
  marketWired = true;
  const maker = `${J} maker ${tag}`;
  for (const [asset, amount] of [
    [base, '100'],
    ['USDC', '20000'],
  ]) {
    const funded = await testVenue('/test/deposit', {
      account: await venueAccount(otherTraderKey(maker).address),
      asset,
      amount,
      depositRef: `seed:${maker}:${symbol}:${asset}`,
    });
    expect(funded.status, JSON.stringify(funded.body)).toBe(200);
  }
  for (const [side, price] of [
    ['sell', VASK],
    ['buy', VBID],
  ]) {
    const answer = await otherTraderRun(maker, {
      kind: 'place_order',
      symbol,
      side,
      type: 'limit',
      amount: '50',
      price,
      timeInForce: 'GTC',
      reduceOnly: false,
      clientOrderKey: `order:${J}:maker:${tag}:${side}:${price}`,
      builderFee: null,
    });
    expect(answer, JSON.stringify(answer).slice(0, 300)).toMatchObject({ accepted: true });
  }
  run.write({ vSymbol: symbol, vBase: base });
  return { symbol, base };
}

/** Opens one venue follow with three copied buys on a fresh leader and agent sub-account. */
async function startVenueFollow(page, { prefix, label, leaderWallet, followerWallet, cap, fundAmount, maxTotal, keyTag }) {
  const { tag } = run.read();
  const { symbol } = await ensureOwnMarket(tag);
  const follower = state('follower');
  const leaderKey = walletOf(leaderWallet);
  const followerKey = walletOf(followerWallet);
  const leader = await fundedTrader(page, prefix, '10');
  const leaderRef = await listLeader(leader, `${label} ${tag}`, { assets: [symbol] });
  const { chainId } = await venueInfo();
  const ref = (who) => `${chainId}:0x${createHash('sha256').update(`${J}:${tag}:${keyTag}:${who}`).digest('hex')}:0`;
  await testDeposit(leaderKey.address.toLowerCase(), 'USDC', '2000', ref('leader'));
  await testDeposit(followerKey.address.toLowerCase(), 'USDC', '500', ref('follower'));
  await approveBuilder(await api(leader), leaderKey, null, `${J}:${tag}:${keyTag}:leader`, symbol);

  const session = await api(follower);
  const passkey = run.read().passkey ? await restorePasskey(state('passkey')) : await testPasskey(session);
  const owner = followerKey.address.toLowerCase();
  const accountId = randomUUID();
  const fields = { accountId, owner, asset: 'USDC', cap, fund: fundAmount };
  const stepUpApprovalId = await confirmStepUp(session, passkey, { ...STEP_UP_AGENT, target: accountId, amount: fundAmount, fields });
  // Saved after its use: later steps answer with the counter past this assertion's, as identity requires.
  run.write({ passkey: passkey.saved() });
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
  await approveBuilder(session, followerKey, view.subAccount, `${J}:${tag}:${keyTag}:sub`, symbol);

  const followed = doorOk(
    await session.post('/api/trade/trpc/copy.follow', {
      leaderRef,
      region: 'DE',
      permittedMarkets: [symbol],
      maxNotionalPerOrder: '50',
      maxAggregateExposure: maxTotal,
      fixedOrderSize: '20',
      expiresAt: new Date(Date.now() + 7 * 24 * 3600_000).toISOString(),
      clientRequestId: `jc3-${keyTag}:${tag}`,
      agentAccountId: accountId,
    }),
  );
  const followId = followed.result.data.followId;
  doorOk(await session.post('/api/trade/trpc/copy.grantSessionKey', { followId }));

  const openFillIds = [];
  for (const n of [1, 2, 3]) {
    openFillIds.push(...(await venueLeadOrder(leader, leaderKey, 'buy', '0.3', `${keyTag}-open${n}`)));
    await expect
      .poll(async () => (await copiedPositions(follower, followId)).filter(isOpen).length, {
        timeout: 60_000,
        message: `the copy driver never copied lead buy ${n} onto the agent sub-account`,
      })
      .toBe(openFillIds.length);
  }
  return {
    leader,
    leaderRef,
    followId,
    accountId,
    owner,
    subAccount: view.subAccount,
    leaderOwner: leaderKey.address.toLowerCase(),
    openFillIds,
  };
}

/** Copied orders on the follow after the page re-reads it. */
async function copiedNow(page) {
  return (await copiedOrdersLoaded(await openFollow(page, state('leaderRef')))).count();
}

test(`${J} #1 pauses the follow: new mirrors refused as paused, and existing positions stay open`, async ({ page, stepPicture }) => {
  test.setTimeout(420_000);
  const tag = Date.now().toString(36);
  // Funded 1000 USDT on the account so #6's email-notice follow wizard also passes; all trading in #1-#5 and #7 is on the TEST venue.
  const follower = await fundedTrader(page, 'jcf3', '1000');
  run.reset({ tag, follower });
  const started = await startVenueFollow(page, {
    prefix: 'jcl3',
    label: 'Journey Exits',
    leaderWallet: 'leader1',
    followerWallet: 'follower1',
    cap: '300',
    fundAmount: '200',
    maxTotal: '200',
    keyTag: 'main',
  });
  const { leader, leaderRef, followId, owner, subAccount, openFillIds } = started;
  run.write({ leader, leaderRef, followId, owner, subAccount, leaderOwner: started.leaderOwner, openFillIds });

  // Every copied buy settled on the follower's own venue sub-account, and the sub-account's base asset matches those fills.
  const base = state('vBase');
  const fillsBefore = await onVenue('/fills', owner, subAccount, { since: new Date(0).toISOString() });
  expect(fillsBefore.filter((f) => f.side === 'buy')).toHaveLength(openFillIds.length);
  expect(fillsBefore.some((f) => f.side === 'sell')).toBe(false);
  let wantBase = 0n;
  for (const f of fillsBefore) {
    wantBase += toUnits(f.amount);
    if (f.feeAsset === base) wantBase -= toUnits(f.venueFee) + toUnits(f.builderFee);
  }
  const subBal = await onVenue('/balances', owner, subAccount);
  expect(assetTotal(subBal, base), `sub-account ${base} matches the copied buy fills on the venue`).toBe(wantBase);

  const before = await venueSnapshot(follower, followId, owner, subAccount);
  expect(before.positions.filter(isOpen).length, 'open copied positions after #1').toBeGreaterThanOrEqual(3);

  await signIn(page, follower);
  const detail = await openFollow(page, leaderRef);
  await act(page, detail, 'Pause');
  await expect(detail.getByText('Paused', { exact: true })).toBeVisible();
  expect((await myFollow(follower, followId)).relationshipState).toBe('PAUSED');

  // A lead buy on the venue while paused: svc-trade writes one skip row for each fill as paused and copies none of it.
  const pausedFillIds = await venueLeadOrder(leader, walletOf('leader1'), 'buy', '0.3', 'main-paused');
  run.write({ pausedFillIds });
  await expect
    .poll(
      async () =>
        (await trpcQuery(follower, 'copy.skipLog', { followId })).items
          .map((s) => [s.leaderFillId, s.reason])
          .sort((a, b) => (a[0] < b[0] ? -1 : 1)),
      { timeout: 60_000, message: 'svc-trade never logged the paused lead venue buy as paused' },
    )
    .toEqual(pausedFillIds.map((id) => [id, 'paused']));

  // Existing positions stay open: svc-trade's copied orders and positions, and the venue's fills, open orders and balances
  // on both the sub-account and main account read identically to before the pause.
  expect(await venueSnapshot(follower, followId, owner, subAccount)).toEqual(before);
  expect(await copiedNow(page)).toBe(openFillIds.length);
  const shown = await openFollow(page, leaderRef);
  await expect(shown.getByText('Paused', { exact: true })).toBeVisible();
  await shown.getByRole('tab', { name: 'Positions', exact: true }).click();
  await expect(shown.getByTestId('copied-positions-source')).toContainText('TEST · As TEST venue simulator reports them');
  await expect(shown.getByRole('table', { name: 'Copied positions', exact: true }).locator('tbody tr')).toHaveCount(openFillIds.length);
  // Reopen at the top of the dialog so the step picture shows the Paused state header cleanly.
  const top = await openFollow(page, leaderRef);
  await expect(top.getByText('Paused', { exact: true })).toBeVisible();
  await expect(top).toContainText('New trades are not being copied');
  await stepPicture();
});

test(`${J} #2 stops with close-only: a new lead fill isn't mirrored, and a lead close still closes the position`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(300_000);
  await ensureOwnMarket(state('tag'));
  const follower = state('follower');
  const followId = state('followId');
  const owner = state('owner');
  const subAccount = state('subAccount');
  const leaderKey = walletOf('leader1');
  await signIn(page, follower);
  const detail = await openFollow(page, state('leaderRef'));
  const atStop = await venueSnapshot(follower, followId, owner, subAccount);
  await act(page, detail, 'Stop');
  // Stop is close-only: the follow reads Stopping while the leader's closes still close the copied positions.
  await expect(detail.getByText('Stopping', { exact: true })).toBeVisible();
  await expect(detail.getByText('Close-only: the leader’s closes still close your copied positions.', { exact: true })).toBeVisible();
  // svc-trade holds the follow as close-only, read back by its owner, and the stop itself closed and moved nothing on the venue.
  expect((await myFollow(follower, followId)).relationshipState).toBe('CLOSE_ONLY');
  expect(await venueSnapshot(follower, followId, owner, subAccount)).toEqual(atStop);
  const copied = async () => (await trpcQuery(follower, 'copy.followPositions', { followId })).positions;
  const copies = state('openFillIds').length;
  expect((await copied()).filter((o) => o.side === 'buy')).toHaveLength(copies);

  // A new lead buy on the venue: svc-trade writes one skip row as stopped and places no venue copy.
  const symbol = state('vSymbol');
  const base = state('vBase');
  const stoppedFillIds = await venueLeadOrder(state('leader'), leaderKey, 'buy', '0.3', 'main-stopped');
  run.write({ stoppedFillIds });
  await expect
    .poll(
      async () =>
        (await trpcQuery(follower, 'copy.skipLog', { followId })).items
          .filter((s) => stoppedFillIds.includes(s.leaderFillId))
          .sort((a, b) => (a.leaderFillId < b.leaderFillId ? -1 : 1))
          .map((s) => [s.leaderFillId, s.reason]),
      { timeout: 60_000, message: 'svc-trade wrote no skip row for the new lead venue buy' },
    )
    .toEqual(stoppedFillIds.map((id) => [id, 'stopped']));
  expect(await venueSnapshot(follower, followId, owner, subAccount)).toEqual(atStop);

  // The leader's close (a sell on the venue) still closes the person's copied position on the agent sub-account: one
  // copied sell, and the sub-account's venue balances move by exactly what its venue fills settle.
  const lot = await venueLot(symbol);
  const positionsBefore = await copiedPositions(follower, followId);
  for (const p of positionsBefore)
    expect(toUnits(p.open), `position ${p.positionId} before the lead close`).toBe((toUnits(p.bought) / lot) * lot);
  const fillsBefore = await onVenue('/fills', owner, subAccount, { since: new Date(0).toISOString() });
  const seenFillIds = new Set(fillsBefore.map((f) => f.fillId));
  const subBefore = await onVenue('/balances', owner, subAccount);
  const mainBefore = await onVenue('/balances', owner);

  await venueLeadOrder(state('leader'), leaderKey, 'sell', '0.3', 'main-close');
  await expect
    .poll(async () => (await copied()).filter((o) => o.side === 'sell' && o.status === 'filled').length, {
      timeout: 60_000,
      message: 'the copied venue sell never filled',
    })
    .toBe(1);
  await expect
    .poll(async () => (await copiedPositions(follower, followId)).filter((p) => p.closing !== '0').length, {
      timeout: 30_000,
      message: 'a copied position still reads closing after the lead close settled',
    })
    .toBe(0);

  // Verify the venue's own fills and balance delta on the follower's agent sub-account.
  const freshFills = (await onVenue('/fills', owner, subAccount, { since: new Date(0).toISOString() })).filter(
    (f) => !seenFillIds.has(f.fillId),
  );
  expect(freshFills.length, 'the copied sell produced at least one venue fill').toBeGreaterThan(0);
  expect(freshFills.every((f) => f.side === 'sell')).toBe(true);
  let sold = 0n;
  let wantBaseDelta = 0n;
  let wantUsdcDelta = 0n;
  for (const f of freshFills) {
    const qty = toUnits(f.amount);
    const price = toUnits(f.price);
    const fee = toUnits(f.venueFee) + toUnits(f.builderFee);
    sold += qty;
    wantBaseDelta -= qty;
    wantUsdcDelta += mulCeil(price, qty);
    if (f.feeAsset === base) wantBaseDelta -= fee;
    if (f.feeAsset === 'USDC') wantUsdcDelta -= fee;
  }
  expect(sold).toBeGreaterThan(0n);
  const subAfter = await onVenue('/balances', owner, subAccount);
  expect(assetTotal(subAfter, base) - assetTotal(subBefore, base), `sub-account ${base} moved by the venue sell fill`).toBe(wantBaseDelta);
  expect(assetTotal(subAfter, 'USDC') - assetTotal(subBefore, 'USDC'), 'sub-account USDC moved by the venue sell fill').toBe(wantUsdcDelta);
  expect(await onVenue('/balances', owner), 'main venue account untouched by copied close').toEqual(mainBefore);

  // FIFO allocation across the copied positions: oldest copy reduced first, newer copies untouched, at least one still open.
  const positionsAfter = await copiedPositions(follower, followId);
  expect(positionsAfter.map((p) => p.positionId)).toEqual(positionsBefore.map((p) => p.positionId));
  let left = sold;
  let untouched = 0;
  for (const was of [...positionsBefore].reverse()) {
    const now = positionsAfter.find((p) => p.positionId === was.positionId);
    const held = toUnits(was.bought);
    const take = left < held ? left : held;
    left -= take;
    expect(toUnits(now.open), `position ${was.positionId}: held ${held}, the lead close took ${take}`).toBe(((held - take) / lot) * lot);
    if (take === 0n) {
      untouched += 1;
      expect(stablePositions([now]), `position ${was.positionId} is newer than what the lead close sold`).toEqual(stablePositions([was]));
    }
  }
  expect(untouched, 'a copy newer than the lead close').toBeGreaterThan(0);
  expect(left, 'the copied sell sold more than the copies held').toBe(0n);
  const after = await copied();
  expect(after.filter((o) => o.side === 'buy')).toHaveLength(copies);
  expect(after.filter((o) => o.side === 'sell')).toHaveLength(1);
  // The page shows the same: Stopping + close-only banner, the buys from before the stop, no copy of the new buy, and one close.
  const shown = await openFollow(page, state('leaderRef'));
  await expect(shown.getByText('Stopping', { exact: true })).toBeVisible();
  await expect(shown.getByText('Close-only: the leader’s closes still close your copied positions.', { exact: true })).toBeVisible();
  const orders = await copiedOrdersLoaded(shown);
  await expect(orders.filter({ hasText: 'Buy' })).toHaveCount(copies);
  await expect(orders.filter({ hasText: 'Sell' })).toHaveCount(1);
  await stepPicture();
});

// ── #3 #4 on the venue: a second venue follow because #4's close-all detaches it ──────────────────────────────────

/** Every fill the venue reports on #3/#4's agent sub-account. */
const subFills = async () => onVenue('/fills', state('vOwner'), state('vSub'), { since: new Date(0).toISOString() });

/**
 * The leader fill a venue copy was made for: the leader's own venue fill (`venue:<leader account>:<ms>:<venue fill id>`,
 * svc-trade copy/venue-copy.ts) whose copy key names that position, `copy-mirror:<follow>:<client order id>`.
 */
async function leaderFillOfVenuePosition(positionId) {
  const followId = state('vFollowId');
  const leaderOwner = state('vLeaderOwner');
  for (const f of await onVenue('/fills', leaderOwner, null, { since: new Date(0).toISOString() })) {
    const id = venueFillIdOf(leaderOwner, f);
    if (`copy-mirror:${followId}:${capped(`copy-mirror:${followId}:${id}`)}` === positionId) return id;
  }
  throw new Error(`no venue fill of the leader's was copied as position ${positionId}`);
}

/** The start for #3 and #4 (above); kept in this run's state. */
async function venueStart(page) {
  if (run.read().vFollowId) return;
  const started = await startVenueFollow(page, {
    prefix: 'jvl3',
    label: 'Journey Venue Exits',
    leaderWallet: 'leader',
    followerWallet: 'follower',
    cap: '200',
    fundAmount: '150',
    maxTotal: '150',
    keyTag: 'venue',
  });
  run.write({
    vLeaderRef: started.leaderRef,
    vFollowId: started.followId,
    vAccountId: started.accountId,
    vOwner: started.owner,
    vSub: started.subAccount,
    vLeaderOwner: started.leaderOwner,
  });
}

test(`${J} #3 opens Positions and closes one order, then a part larger than open: the close is one venue order by the agent permission, sent once, read closed as the venue reports it; the oversize part refused before anything is sent`, async ({
  page,
}) => {
  test.setTimeout(480_000);
  await venueStart(page);
  const follower = state('follower');
  const followId = state('vFollowId');
  const owner = state('vOwner');
  const subAccount = state('vSub');
  await signIn(page, follower);
  const detail = await openFollow(page, state('vLeaderRef'));
  await detail.getByRole('tab', { name: 'Positions' }).click();
  const table = detail.getByRole('table', { name: 'Copied positions' });
  // The positions are the venue's own record of the sub-account, and the screen says so.
  await expect(detail.getByTestId('copied-positions-source')).toContainText('TEST · As TEST venue simulator reports them');
  const rowOf = async (list, positionId) => {
    const at = list.findIndex((p) => p.positionId === positionId);
    const row = table.locator('tbody tr').nth(at);
    await expect(row).toContainText(list[at].market);
    await expect(row).toContainText(list[at].bought);
    return row;
  };
  const positionsBefore = await copiedPositions(follower, followId);
  const open = positionsBefore.filter(isOpen);
  expect(open.length, 'open copied positions before #3, so closing one is not closing all').toBeGreaterThanOrEqual(2);
  for (const p of positionsBefore) expect(p.reportedBy).toMatchObject({ test: true });
  // Each copied position is what the venue reports its copy filled on the sub-account.
  const fillsBefore = await subFills();
  const bought = fillsBefore.filter((f) => f.side === 'buy').reduce((s, f) => s + toUnits(f.amount), 0n);
  expect(positionsBefore.reduce((s, p) => s + toUnits(p.bought), 0n) <= bought).toBe(true);
  expect(
    fillsBefore.some((f) => f.side === 'sell'),
    'nothing was sold on the sub-account before #3',
  ).toBe(false);
  const target = open[0];
  const others = positionsBefore.filter((p) => p.positionId !== target.positionId);
  // The close runs once under `copy.close:<followId>:<leader fill>`.
  const leaderFill = await leaderFillOfVenuePosition(target.positionId);
  expect(
    await onVenue('/order-by-client-id', owner, subAccount, { venueClientOrderId: await cloidOf(`copy.close:${followId}:${leaderFill}`) }),
  ).toBeNull();
  const mainBefore = await onVenue('/balances', owner);
  const subBefore = await onVenue('/balances', owner, subAccount);

  // Close one, twice at once (the screen's close and the same close by API): one venue order, sent once.
  const row = await rowOf(positionsBefore, target.positionId);
  await row.getByRole('button', { name: 'Close', exact: true }).click();
  const client = await api(follower);
  const onScreen = page.waitForResponse((r) => r.url().includes('copy.closeCopiedPosition'));
  const sent = page.waitForRequest((r) => r.url().includes('copy.closeCopiedPosition'));
  const [, byApi] = await Promise.all([
    page.getByRole('alertdialog').getByRole('button', { name: 'Close' }).click(),
    client.post('/api/trade/trpc/copy.closeCopiedPosition', { followId, positionId: target.positionId }),
  ]);
  expect((await sent).postData() ?? '', 'the screen closed another position').toContain(target.positionId);
  const screenBody = await (await onScreen).json();
  const answers = [screenBody, byApi.body].map((body) => body?.result?.data?.orderId ?? refusalCode({ body }));
  const closeKeys = answers.filter((a) => a && a.startsWith('copy.close:'));
  expect(
    closeKeys.length,
    `neither close sent an order: ${JSON.stringify(answers)} ${JSON.stringify([screenBody, byApi.body]).slice(0, 1500)}`,
  ).toBeGreaterThan(0);
  for (const a of answers) expect(['trade.copy_position_closed', closeKeys[0]]).toContain(a);
  const closeKey = closeKeys[0];
  // The close's key names the follow and the leader fill the position was copied from.
  expect(closeKey).toBe(`copy.close:${followId}:${leaderFill}`);
  const cloid = await cloidOf(closeKey);
  // On the venue: one order under that key's client order id, on the agent sub-account, a sell of exactly what was open.
  // Nothing in the browser can sign (no wallet is connected on this page), and the only key INTAFACED holds for that
  // sub-account is its agent key, the one the venue lists on it: the agent permission placed it.
  const order = await onVenue('/order-by-client-id', owner, subAccount, { venueClientOrderId: cloid });
  expect(order, 'the venue has no order under the close key').toBeTruthy();
  expect(order).toMatchObject({ side: 'sell', symbol: state('vSymbol') });
  expect(sameUnits(order.amount, target.open)).toBe(true);
  const agents = await onVenue('/agents', owner, subAccount);
  expect(agents.length).toBe(1);
  // The venue's record of who signed it: the sub-account's agent key, as an agent, never the person's wallet.
  const signer = await onVenue('/order-signer', owner, subAccount, { venueClientOrderId: cloid });
  expect(signer).toEqual({ role: 'agent', address: agents[0].address.toLowerCase() });
  expect(signer.address).not.toBe(owner);
  expect(await onVenue('/order-by-client-id', owner, null, { venueClientOrderId: cloid })).toBeNull();
  // The position reads closed as the venue reports it: its close's fills sold exactly what was open, and nothing else sold.
  await expect
    .poll(
      async () => {
        const p = (await copiedPositions(follower, followId)).find((x) => x.positionId === target.positionId);
        return p && { open: p.open, closing: p.closing, status: p.status };
      },
      { timeout: 30_000 },
    )
    .toEqual({ open: '0', closing: '0', status: 'closed' });
  await expect(row).toContainText('Closed');
  const sells = (await subFills()).filter((f) => f.side === 'sell');
  expect(sells.every((f) => f.venueClientOrderId === cloid)).toBe(true);
  expect(sells.reduce((s, f) => s + toUnits(f.amount), 0n)).toBe(toUnits(target.open));
  // What it freed stays on the follower's own sub-account, as the venue reports it; the main venue account is untouched.
  const subAfter = await onVenue('/balances', owner, subAccount);
  const usdc = (list) => toUnits(list.find((b) => b.asset === 'USDC')?.total ?? '0');
  expect(usdc(subAfter) > usdc(subBefore)).toBe(true);
  expect(await onVenue('/balances', owner)).toEqual(mainBefore);
  // Every other position is as it was.
  const afterClose = await copiedPositions(follower, followId);
  const stable = (list) => list.map(({ reportedBy: _r, ...p }) => p);
  expect(stable(afterClose.filter((p) => p.positionId !== target.positionId))).toEqual(stable(others));

  // The same close sent again: refused as closed, and no second order reaches the venue.
  const again = await (await api(follower)).post('/api/trade/trpc/copy.closeCopiedPosition', { followId, positionId: target.positionId });
  expect(refusalCode(again), JSON.stringify(again.body).slice(0, 300)).toBe('trade.copy_position_closed');
  expect((await subFills()).filter((f) => f.side === 'sell')).toEqual(sells);

  // A part larger than what is open on a position still open: refused by its typed code before anything is sent.
  const still = afterClose.find((p) => p.positionId !== target.positionId && isOpen(p));
  expect(still, 'an open copied position left for the oversize part').toBeTruthy();
  const openOrdersBefore = await onVenue('/open-orders', owner, subAccount);
  const partRow = await rowOf(afterClose, still.positionId);
  await partRow.getByRole('button', { name: 'Close part' }).click();
  const part = page.getByRole('dialog', { name: 'Close part of this position' });
  await part.getByLabel('Amount').fill('1');
  const oversize = page.waitForResponse((r) => r.url().includes('copy.closeCopiedPosition'));
  const partSent = page.waitForRequest((r) => r.url().includes('copy.closeCopiedPosition'));
  await part.getByRole('button', { name: 'Close' }).click();
  expect((await partSent).postData() ?? '', 'the screen sent the part for another position').toContain(still.positionId);
  expect(refusalCode({ body: await (await oversize).json() })).toBe('trade.copy_close_qty_exceeds');
  const refusal = detail.getByRole('note').filter({ hasText: 'That is more than is open.' });
  await expect(refusal).toBeVisible();
  // It names what was refused: the part asked for, the position's market and what is open on it.
  await expect(refusal).toContainText(`You asked to close 1 of ${still.market}; ${still.open} is open. Nothing was sent.`);
  // Every cell of the positions and their fills reads whole, none cut short.
  for (const name of ['Copied positions', 'Copied fills']) {
    const cut = await detail
      .getByRole('table', { name })
      .locator('td')
      .evaluateAll((cells) => cells.filter((c) => c.scrollWidth > c.clientWidth).map((c) => c.textContent));
    expect(cut, `${name}: cells cut short`).toEqual([]);
  }
  const stillFill = await leaderFillOfVenuePosition(still.positionId);
  expect(
    await onVenue('/order-by-client-id', owner, subAccount, { venueClientOrderId: await cloidOf(`copy.close:${followId}:${stillFill}:1`) }),
  ).toBeNull();
  expect(await onVenue('/open-orders', owner, subAccount)).toEqual(openOrdersBefore);
  expect((await subFills()).filter((f) => f.side === 'sell')).toEqual(sells);
  expect(stable(await copiedPositions(follower, followId))).toEqual(stable(afterClose));
});

test(`${J} #4 presses close-all with an unrealised loss: a step-up opens and the call without its token is refused; with it each position is closed by a venue order and reads closed as the venue reports it`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  await ensureOwnMarket(state('tag'));
  const follower = state('follower');
  const followId = state('vFollowId');
  const owner = state('vOwner');
  const subAccount = state('vSub');
  const open = (await copiedPositions(follower, followId)).filter(isOpen);
  expect(open.length, 'open copied positions before the close-all').toBeGreaterThan(0);
  // An unrealised loss: each copy was bought at the TEST ask and would sell now at the lower TEST bid.
  const symbol = state('vSymbol');
  const book = (await testVenue('/book', { symbol, depth: 1 })).body.value;
  const fills = await subFills();
  const paid = fills.filter((f) => f.side === 'buy').map((f) => toUnits(f.price));
  expect(paid.length).toBeGreaterThan(0);
  expect(
    paid.every((p) => toUnits(book.bids[0].price) < p),
    'the TEST bid is below what every copy paid',
  ).toBe(true);

  // The call without its step-up token: refused, and nothing reaches the venue.
  const sellsBefore = fills.filter((f) => f.side === 'sell');
  const bare = await (await api(follower)).post('/api/trade/trpc/copy.flatten', { followId });
  expect(refusalCode(bare), `svc-trade answered ${bare.status} ${JSON.stringify(bare.body).slice(0, 200)}`).toBe(
    'identity.step_up_required',
  );
  expect((await subFills()).filter((f) => f.side === 'sell')).toEqual(sellsBefore);

  // On screen, pressing Close copied positions opens the step-up sheet before anything is sent.
  await signIn(page, follower);
  const detail = await openFollow(page, state('vLeaderRef'));
  await detail.getByRole('button', { name: 'Close copied positions' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Close copied positions' }).click();
  await expect(page.getByRole('dialog', { name: 'Confirm it’s you' }), 'no step-up opens').toBeVisible();
  expect((await subFills()).filter((f) => f.side === 'sell')).toEqual(sellsBefore);
  await page.keyboard.press('Escape');

  // With the token (the person's TEST passkey answering identity's step-up for exactly this follow and request): one venue
  // order per open position, each under `copy.flatten:<followId>:<leader fill>`, on the agent sub-account.
  const session = await api(follower);
  const passkey = await restorePasskey(state('passkey'));
  const requestId = `jc3-all-${run.read().tag}`;
  const stepUpApprovalId = await confirmStepUp(session, passkey, {
    scope: 'trade.step_up.copy.flatten',
    purpose: 'copy.flatten',
    target: followId,
    fields: { followId, requestId },
  });
  run.write({ passkey: passkey.saved() });
  const done = doorOk(await session.post('/api/trade/trpc/copy.flatten', { followId, requestId, stepUpApprovalId }));
  const keys = (
    await Promise.all(open.map(async (p) => `copy.flatten:${followId}:${await leaderFillOfVenuePosition(p.positionId)}`))
  ).sort();
  expect([...done.result.data.orderIds].sort()).toEqual(keys);
  for (const key of keys) {
    const order = await onVenue('/order-by-client-id', owner, subAccount, { venueClientOrderId: await cloidOf(key) });
    expect(order, `no venue order under ${key}`).toMatchObject({ side: 'sell', symbol });
  }
  // Each position reads closed as the venue reports it: the close-all's fills sold exactly what was open.
  await expect
    .poll(async () => (await copiedPositions(follower, followId)).every((p) => p.status === 'closed'), { timeout: 30_000 })
    .toBe(true);
  expect((await copiedPositions(follower, followId)).filter(isOpen)).toEqual([]);
  const cloids = await Promise.all(keys.map(cloidOf));
  const flattenSells = (await subFills()).filter((f) => f.side === 'sell' && cloids.includes(f.venueClientOrderId));
  expect(flattenSells.reduce((s, f) => s + toUnits(f.amount), 0n)).toBe(open.reduce((s, p) => s + toUnits(p.open), 0n));
  // And the screen lists every one of them as Closed.
  const shown = await openFollow(page, state('vLeaderRef'));
  await shown.getByRole('tab', { name: 'Positions' }).click();
  const rows = shown.getByRole('table', { name: 'Copied positions' }).locator('tbody tr');
  await expect(rows).toHaveCount((await copiedPositions(follower, followId)).length);
  for (const r of await rows.all()) await expect(r).toContainText('Closed');
});

test(`${J} #5 opens the skip log: one row per skipped mirror with the reason in words; a repeat writes no second row`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(180_000);
  await ensureOwnMarket(state('tag'));
  const follower = state('follower');
  const followId = state('followId');
  const owner = state('owner');
  const subAccount = state('subAccount');
  const leaderKey = walletOf('leader1');
  const paused = state('pausedFillIds');
  const stopped = state('stoppedFillIds');
  // svc-trade's log holds exactly the fills skipped while paused (#1) and while stopped (#2), each once.
  const sorted = (rows) => [...rows].sort((a, b) => (a.leaderFillId < b.leaderFillId ? -1 : 1));
  const items = sorted((await trpcQuery(follower, 'copy.skipLog', { followId })).items);
  expect(items.map((s) => [s.leaderFillId, s.reason])).toEqual(
    [...paused.map((id) => [id, 'paused']), ...stopped.map((id) => [id, 'stopped'])].sort((a, b) => (a[0] < b[0] ? -1 : 1)),
  );

  // The screen lists the same rows, each reason in words, no raw code.
  await signIn(page, follower);
  const detail = await openFollow(page, state('leaderRef'));
  await detail.getByRole('tab', { name: 'Skipped', exact: true }).click();
  const log = detail.getByRole('table', { name: 'Skipped copies', exact: true });
  await expect(log.locator('tbody tr')).toHaveCount(items.length);
  await expect(log.locator('tbody tr').filter({ hasText: 'You had paused this follow' })).toHaveCount(paused.length);
  await expect(log.locator('tbody tr').filter({ hasText: 'You had stopped this follow' })).toHaveCount(stopped.length);
  await expect(log).not.toContainText(/trade\.[a-z_]+/);

  // A new lead buy on the venue is skipped as stopped, once per fill, and the rows already logged read exactly as before.
  const nextIds = await venueLeadOrder(state('leader'), leaderKey, 'buy', '0.3', 'main-5-sweep');
  await expect
    .poll(
      async () =>
        sorted((await trpcQuery(follower, 'copy.skipLog', { followId })).items.filter((s) => nextIds.includes(s.leaderFillId))).map((s) => [
          s.leaderFillId,
          s.reason,
        ]),
      { timeout: 60_000, message: 'the copy driver never swept the new lead venue buy' },
    )
    .toEqual(nextIds.map((id) => [id, 'stopped']));
  const reread = sorted((await trpcQuery(follower, 'copy.skipLog', { followId })).items);
  expect(reread.filter((s) => !nextIds.includes(s.leaderFillId))).toEqual(items);
  expect(reread).toHaveLength(items.length + nextIds.length);

  // A repeat of the same venue fill: the stack's LOCAL TEST rewind moves the follow's copy cursor to just before one
  // logged venue fill, and one more lead buy drives one sweep from there. Once that buy's fills are logged, the sweep
  // has passed the rewound fill again: it still has exactly one row, every row reads as before, and nothing moved on the venue.
  const repeated = nextIds[0];
  const atRewind = await venueSnapshot(follower, followId, owner, subAccount);
  tool('local-test-gates.mjs', 'copy-rewind', followId, repeated);
  const driveIds = await venueLeadOrder(state('leader'), leaderKey, 'buy', '0.3', 'main-5-repeat');
  await expect
    .poll(
      async () => (await trpcQuery(follower, 'copy.skipLog', { followId })).items.filter((s) => driveIds.includes(s.leaderFillId)).length,
      { timeout: 60_000, message: 'the copy driver never swept after the rewind' },
    )
    .toBe(driveIds.length);
  const afterRepeat = sorted((await trpcQuery(follower, 'copy.skipLog', { followId })).items);
  expect(
    afterRepeat.filter((s) => s.leaderFillId === repeated),
    `skip rows for the repeated fill ${repeated}`,
  ).toHaveLength(1);
  expect(afterRepeat.filter((s) => !driveIds.includes(s.leaderFillId))).toEqual(reread);
  expect(afterRepeat).toHaveLength(reread.length + driveIds.length);
  expect(await venueSnapshot(follower, followId, owner, subAccount)).toEqual(atRewind);
  const finalDialog = await openFollow(page, state('leaderRef'));
  await finalDialog.getByRole('tab', { name: 'Skipped', exact: true }).click();
  await expect(finalDialog.getByRole('table', { name: 'Skipped copies', exact: true }).locator('tbody tr')).toHaveCount(afterRepeat.length);
  await stepPicture();
});

/** One svc-notify read as the follower. */
async function notifyRead(who, procedure, input) {
  const query = input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`;
  const res = await (await api(who)).get(`/api/notify/trpc/${procedure}${query}`);
  expect(res.status, `${procedure}: ${JSON.stringify(res.body).slice(0, 300)}`).toBe(200);
  return res.body.result.data;
}

/** The stop notices svc-notify holds for one follow. */
const stopNotices = async (who, followId) =>
  (await notifyRead(who, 'notify.list', { limit: 100 })).items.filter(
    (n) => n.kind === 'trade.copy.stopped' && n.params.followId === followId,
  );

const CLOSE_ONLY_WORDS = 'You stopped this follow. Only the leader’s closes of what you hold are still copied.';
const CLOSE_ONLY_NEXT = 'You can leave the leader any time.';

test(`${J} #6 receives an in-app notice for a skipped or stopped follow: the reason and the next step, no raw code; one email when the vendor is set, otherwise the vendor text only`, async ({
  page,
}) => {
  test.setTimeout(480_000);
  const follower = state('follower');
  const followId = state('followId');
  // svc-notify holds exactly one stop notice for #2's close-only stop of this follow, however often it was announced.
  const stops = await stopNotices(follower, followId);
  expect(
    stops.map((n) => n.bodyKey),
    'B5 copy notices: no stop notice for this follow in svc-notify',
  ).toEqual(['notify.trade.copy_stopped.body.follower_close_only']);
  // The inbox shows it: the reason (the person stopped it, closes still copied) and the next step, each in words, no raw code.
  await signIn(page, follower);
  await page.goto('/notifications');
  const notice = page.getByTestId('nf-row').filter({ hasText: /stopped copying/ });
  await expect(notice).toHaveCount(1);
  await expect(notice).toContainText('Your follow stopped copying');
  await expect(notice).toContainText(CLOSE_ONLY_WORDS);
  await expect(notice).toContainText(CLOSE_ONLY_NEXT);
  await expect(notice).not.toContainText(/trade\.[a-z_]+|notify\.[a-z_]+/);

  // No email sender is set on the stack, as in this build: the platform says email is not set up, no address can be
  // confirmed, and so no email copy of the notice exists. Its delivery record names the outside service it waits on.
  const channels = await notifyRead(follower, 'notify.channels');
  expect(channels.find((c) => c.channel === 'email')).toMatchObject({ configured: false });
  const before = await notifyRead(follower, 'notify.deliveries', { notificationId: stops[0].id });
  expect(before.filter((d) => d.channel === 'email')).toEqual([]);
  expect(mailbox().filter((m) => m.to === follower.email)).toEqual([]);
  await page.goto('/notifications?view=delivery');
  // One record per update: the list item that holds the update's title (its channel rows are list items inside it).
  const record = page.getByRole('listitem').filter({ hasText: 'Your follow stopped copying' });
  await expect(record).toHaveCount(1);
  await record.getByRole('button', { name: 'Show delivery', exact: true }).click();
  await expect(record.locator('[data-not-connected="vendor.email"]')).toHaveText(
    'An email copy of this update needs an email sender. It is switched off in this build. vendor.email',
  );

  // With the TEST email stand-in set (the stack's LOCAL TEST sender, which writes each email to a file), the person
  // confirms their address, and the next stop notice goes out as one email.
  await restartService('notify', { LOCAL_STACK_NOTIFY_EMAIL: 'on' });
  try {
    await page.goto('/notifications?view=settings');
    const card = page.locator('[data-testid="nf-channelcard"][data-channel="email"]');
    await card.getByRole('button', { name: 'Add address', exact: true }).click();
    await card.getByRole('textbox', { name: /^Email address/ }).fill(follower.email);
    const seen = mailbox().length;
    await card.getByRole('button', { name: 'Save and send a code', exact: true }).click();
    let code;
    await expect
      .poll(
        () => {
          const line = mailbox()
            .slice(seen)
            .find((m) => m.to === follower.email && m.kind === 'notify.channel.verify');
          code = line ? /Your confirmation code is (\d{6})\b/.exec(line.text)?.[1] : undefined;
          return code;
        },
        { timeout: 30_000 },
      )
      .toMatch(/^\d{6}$/);
    await card.getByRole('textbox', { name: /^Six-digit code/ }).fill(code);
    await card.getByRole('button', { name: 'Confirm address', exact: true }).click();
    await expect(card).toContainText('Address confirmed.');

    // A follow of its own for this stop (#4's close-all detached the venue follow, and #2's follow is already stopped):
    // a fresh TEST leader, followed through the app's own follow steps, then stopped close-only.
    const eLeader = await fundedTrader(page, 'jcl3e', '10');
    const eLeaderRef = await listLeader(eLeader, `Journey Email ${state('tag')}`);
    const eFollowId = await followOnScreen(page, follower, eLeaderRef, { perOrder: '50', total: '100', fixed: '20' });
    expect(await stopNotices(follower, eFollowId), 'the new follow had no stop notice before').toEqual([]);
    const session = await api(follower);
    const stop = await session.post('/api/trade/trpc/copy.stop', { followId: eFollowId, closeOnly: true });
    expect(stop.status, JSON.stringify(stop.body).slice(0, 300)).toBe(200);
    const stopMail = () => mailbox().filter((m) => m.to === follower.email && m.kind === 'trade.copy.stopped');
    await expect.poll(() => stopMail().length, { timeout: 60_000, message: 'no email copy of the stop notice' }).toBe(1);
    const [mail] = stopMail();
    expect(mail.subject).toMatch(/^TEST · /);
    expect(mail.subject).toContain('Your follow stopped copying');
    expect(mail.text).toMatch(/^TEST — written by the LOCAL TEST email stand-in, not sent\./);
    expect(mail.text).toContain(CLOSE_ONLY_WORDS);
    expect(mail.text).toContain(CLOSE_ONLY_NEXT);
    expect(mail.text).not.toMatch(/trade\.[a-z_]+|notify\.[a-z_]+/);
    // One notice and one email: the record holds one accepted email row, and the same stop again sends no second.
    const [vStop] = await stopNotices(follower, eFollowId);
    expect(vStop.bodyKey).toBe('notify.trade.copy_stopped.body.follower_close_only');
    await expect
      .poll(
        async () =>
          (await notifyRead(follower, 'notify.deliveries', { notificationId: vStop.id }))
            .filter((d) => d.channel === 'email')
            .map((d) => d.status),
        { timeout: 30_000 },
      )
      .toEqual(['accepted']);
    // The same stop sent again (answered or refused): no second notice and no second email.
    await session.post('/api/trade/trpc/copy.stop', { followId: eFollowId, closeOnly: true });
    expect(await stopNotices(follower, eFollowId)).toHaveLength(1);
    expect(stopMail(), 'still one email for the one stop').toHaveLength(1);
    // The delivery record now shows the email copy, and no vendor text. (Making the new leader used this page, so the
    // follower signs in again.)
    await signIn(page, follower);
    await page.goto('/notifications?view=delivery');
    const sent = page.getByRole('listitem').filter({ hasText: 'Your follow stopped copying' }).first();
    await sent.getByRole('button', { name: 'Show delivery', exact: true }).click();
    const emailRow = sent.getByRole('listitem').filter({ has: page.getByText('Email', { exact: true }) });
    await expect(emailRow).toHaveCount(1);
    await expect(emailRow).toContainText('Handed off for delivery');
    await expect(sent.locator('[data-not-connected="vendor.email"]')).toHaveCount(0);
  } finally {
    await restartService('notify', { LOCAL_STACK_NOTIFY_EMAIL: null });
  }
});

test(`${J} #7 leaves the leader: the follow is left and the positions stay the person's own; leaving again is refused`, async ({
  page,
  stepPicture,
}) => {
  const follower = state('follower');
  const followId = state('followId');
  const owner = state('owner');
  const subAccount = state('subAccount');
  await signIn(page, follower);
  const base = state('vBase');
  const before = await venueSnapshot(follower, followId, owner, subAccount);
  const openBefore = before.positions.reduce((sum, p) => sum + toUnits(p.open), 0n);
  expect(openBefore, 'a copied position is still open when the follow is left').toBeGreaterThan(0n);
  expect(
    assetTotal(await onVenue('/balances', owner, subAccount), base),
    `the follower sub-account holds the open ${base} on the venue before leaving`,
  ).toBeGreaterThanOrEqual(openBefore);

  const detail = await openFollow(page, state('leaderRef'));
  await act(page, detail, 'Leave leader');
  // The state badge itself: the dialog's "Left to use" limit already contains "Left" before the leave lands (#7739).
  await expect(detail.getByText('Left', { exact: true })).toBeVisible();
  // svc-trade holds the follow as left, and nothing was closed or moved on the venue.
  const followAfter = await myFollow(follower, followId);
  expect(followAfter.relationshipState).toBe('DETACHED');
  expect(await venueSnapshot(follower, followId, owner, subAccount)).toEqual(before);
  // Leaving again: the button is off and says why.
  await expect(detail.getByRole('button', { name: 'Leave leader', exact: true })).toBeDisabled();
  await expect(detail.getByText('Leave leader: You have already left this leader', { exact: true })).toBeVisible();
  // The same leave by API is refused by its typed code, and the follow, its positions, orders and venue balances read the same.
  const again = await (await api(follower)).post('/api/trade/trpc/copy.detach', { followId });
  expect(refusalCode(again), `leave again: svc-trade answered ${again.status} ${JSON.stringify(again.body).slice(0, 200)}`).toBe(
    'trade.copy_detached',
  );
  expect(await myFollow(follower, followId)).toEqual(followAfter);
  expect(await venueSnapshot(follower, followId, owner, subAccount)).toEqual(before);
  await stepPicture();
});
