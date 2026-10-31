import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test, expect } from './journey.mjs';
import { randomUUID } from 'node:crypto';
import {
  approverSessions,
  grantVipTrial,
  makeContext,
  reviewVipApplication,
  setFeeDiscountSchedule,
  setFeeSchedule,
} from '../../../../tooling/scripts/local-test-gates.mjs';
import { EDGE, api, bestPrices, fromUnits, fund, journeyState, otherTrader, times, toUnits } from './stack.mjs';
import {
  awayBid,
  confirm,
  deskPath,
  free,
  fundedTrader,
  held,
  openDesk,
  openOrders,
  placements,
  reviewSheet,
  signIn,
  signUp,
  verify,
} from './desk.mjs';
import { draftNotice, publishNotice } from './notices.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';

// J-cex-spot-10, in the running app (docs/roadmap/journeys.json): a person sees what they pay, what tier they are in,
// and how to get cheaper. One test per step, titled "J-cex-spot-10 #<n>", run in order on one TEST account funded with
// TEST USDT through the real ledger. The owner's schedule is written the way two operators would, through svc-trade's
// two-person door (`setFeeSchedule`), as TEST versions: the default pair group keeps the stack's own regular rates
// (maker 0.08%, taker 0.10%), so every other journey on the stack trades at the rates it always did. TEST groups hold
// markets no other journey trades: ETH/USDC at zero fee, and IFC/USDT, which #3 leaves blank for a moment. #5-#6 add a
// TEST tier programme only for as long as they run, and #11 once more. #9 adds TEST terms for paying fees in IFC and a
// TEST stake-discount ladder, and takes the terms away again. Step 7 joins this file with the slice that builds it.
const J = 'J-cex-spot-10';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

/** TEST rates through the real write path, not owner decisions. A TEST VIP tier lowers both rates. */
const REGULAR = { pairGroup: 'all-others', tierId: 'regular', zeroFee: false, makerBps: '8', takerBps: '10', minFee: null };
const VIP = { pairGroup: 'all-others', tierId: 'test-vip-1', zeroFee: false, makerBps: '6', takerBps: '9', minFee: null };
const ZERO = { pairGroup: 'test-zero-fee', tierId: 'regular', zeroFee: true, minFee: null };
/**
 * A stored version replaces the stack's boot schedule for every later order, futures too, so it carries the stack's own
 * perpetual block (tooling/scripts/local-stack-services/trade.mjs) unchanged.
 */
const SCHEDULE = {
  defaultPairGroup: 'all-others',
  pairGroups: { 'ETH/USDC': 'test-zero-fee' },
  rows: [REGULAR, VIP, ZERO],
  perpetual: { makerBps: '2', takerBps: '5' },
};
/** The same, with IFC/USDT in a pair group the owner named and gave no row: its rate is blank. */
const BLANK_IFC = { ...SCHEDULE, pairGroups: { ...SCHEDULE.pairGroups, 'IFC/USDT': 'test-unpriced' } };
/** The same, with IFC/USDT in a TEST group whose maker pays nothing and earns 0.05% back out of the taker's 0.10%. */
const REBATE = {
  pairGroup: 'test-rebate',
  tierId: 'regular',
  zeroFee: false,
  makerBps: '0',
  takerBps: '10',
  makerRebateBps: '5',
  minFee: null,
};
const REBATE_IFC = {
  ...SCHEDULE,
  pairGroups: { ...SCHEDULE.pairGroups, 'IFC/USDT': 'test-rebate' },
  rows: [...SCHEDULE.rows, REBATE],
};
/** IFC/USDT in a TEST group at maker `makerBps`, taker 0.10%: #10 lowers the maker rate in a later version. */
const changeTo = (makerBps) => ({
  ...SCHEDULE,
  pairGroups: { ...SCHEDULE.pairGroups, 'IFC/USDT': 'test-fee-change' },
  rows: [...SCHEDULE.rows, { pairGroup: 'test-fee-change', tierId: 'regular', zeroFee: false, makerBps, takerBps: '10', minFee: null }],
});

/** TEST threshold, not an owner value: 1,000 of counted volume over 30 days puts an account on the TEST VIP tier. */
const VIP_FROM = '1000';
/**
 * SCHEDULE with a TEST tier programme whose daily snapshot runs at `snapshotAt`'s minute (UTC). A programme needs a row
 * for each of its tiers in every pair group, so the zero-fee group gains the TEST VIP tier, still at zero fee.
 */
const tiersAt = (snapshotAt) => ({
  ...SCHEDULE,
  rows: [...SCHEDULE.rows, { ...ZERO, tierId: 'test-vip-1' }],
  tierProgram: {
    thresholds: [{ tierId: 'test-vip-1', minVolume30d: VIP_FROM }],
    volumeQuotes: ['USDT', 'USDC'],
    snapshotTimeUtc: snapshotAt.toISOString().slice(11, 16),
    downgradeGraceDays: null,
    subAccounts: null,
    botsAndCopy: null,
  },
});

test.describe.configure({ mode: 'default' });

function account() {
  const who = run.read().account;
  if (!who) throw new Error(`${J} #1 made no account, so this step has no one to act as`);
  return who;
}

const published = async () => {
  const res = await fetch(`${EDGE}/api/v1/fees/published`);
  return { status: res.status, body: await res.json() };
};

/** The stack's two TEST operators, signed in once for the file. */
let operators;
async function ops() {
  if (!operators) {
    const ctx = await makeContext({ log: () => undefined });
    operators = { ctx, sessions: await approverSessions(ctx) };
  }
  return operators;
}

/**
 * Write `schedule` as the next version, effective in ten seconds or just after `after` (a version already stored to
 * take effect later, since svc-trade refuses one that would start before it), and wait until the public read serves it.
 */
async function publish(schedule, reason, after = null) {
  const { ctx, sessions } = await ops();
  const effectiveAt = Math.max(Date.now() + 10_000, after ? Date.parse(after) + 5_000 : 0);
  const row = await setFeeSchedule(ctx, schedule, { effectiveAt, reason: `LOCAL TEST ${J}: ${reason}`, sessions });
  await expect.poll(async () => (await published()).body.version, { timeout: 30_000 }).toBe(`v${row.version}`);
  return row;
}

/** `bps` as the desk and the fee page write a rate: 8 → "0.08%". */
const pct = (bps) => `${Math.floor(bps / 100)}.${String(bps % 100).padStart(2, '0')}%`;

/** The account's own fills of order `id`, once the service has settled at least one. */
async function fillsOf(client, symbol, id) {
  let fills = [];
  await expect
    .poll(
      async () => {
        const { status, body } = await client.get(`/api/v1/account/trades?symbol=${encodeURIComponent(symbol)}&limit=100`);
        expect(status).toBe(200);
        fills = (Array.isArray(body) ? body : (body.trades ?? [])).filter((f) => f.order === id);
        return fills.length;
      },
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0);
  return fills;
}

/**
 * The other TEST trader sells into `who`'s resting IFC/USDT buy `id` with an IOC, through any house bids at or above its
 * price (its own level included, so a house bid that queued there first cannot leave it unfilled; the rest of the IOC
 * cancels), and waits until nothing of `who`'s rests. The house quotes keep moving, so a bid that joined ahead between the
 * depth read and the IOC can take it; while the buy still rests, the next IOC is sized on a fresh read of the depth and
 * of what the buy has left.
 */
async function sellInto(who, { id, price }, clientOrderId) {
  const until = Date.now() + 30_000;
  for (let round = 1; ; round += 1) {
    const resting = (await openOrders(who, 'IFC/USDT')).find((o) => o.id === id);
    if (!resting || Date.now() >= until) break;
    const { body } = await bestPrices('IFC/USDT');
    const ahead = body.bids.filter(([p]) => toUnits(p) >= toUnits(price)).reduce((sum, [, size]) => sum + toUnits(size), 0n);
    const size = fromUnits(ahead + toUnits(resting.remaining));
    const seller = otherTrader();
    fund(seller.email, 'IFC', size);
    const sell = await (
      await api(seller)
    ).post('/api/v1/orders', {
      symbol: 'IFC/USDT',
      side: 'sell',
      type: 'limit',
      amount: size,
      price,
      timeInForce: 'IOC',
      clientOrderId: round === 1 ? clientOrderId : `${clientOrderId}-${round}`,
    });
    expect(sell.status, JSON.stringify(sell.body).slice(0, 300)).toBeLessThan(300);
    // Only bids that joined ahead may leave the buy resting: they then took the whole IOC. An IOC that stopped short
    // while the buy rested at its price is a matching fault, never a reason to try again.
    const still = (await openOrders(who, 'IFC/USDT')).find((o) => o.id === id);
    const whole = toUnits(sell.body.filled) === toUnits(size);
    expect(!still || whole, `IOC round ${round} left ${id} resting: ${JSON.stringify(sell.body).slice(0, 300)}`).toBe(true);
  }
  await expect.poll(async () => (await openOrders(who, 'IFC/USDT')).length, { timeout: 30_000 }).toBe(0);
}

/**
 * A post-only IFC/USDT buy 3% under the best bid, below the house ladder. It has to rest for minutes: the local market's
 * own taker sells into the best bid every few cycles, and a buy at the top of the book was filled by it while the
 * journey waited (`trade.fills`: test_taker's LTEST- IOC took all 200). The walk moves at most 12 bps a step, so the
 * house bids stay above it; `sellInto` sells through them to reach it.
 */
async function restingIfcBuy(client, amount, clientOrderId) {
  const { bid } = await bestPrices('IFC/USDT');
  const price = fromUnits(((toUnits(bid) * 97n) / 100n / 10n ** 14n) * 10n ** 14n);
  const placed = await client.post('/api/v1/orders', {
    symbol: 'IFC/USDT',
    side: 'buy',
    type: 'limit',
    amount,
    price,
    timeInForce: 'PO',
    clientOrderId,
  });
  expect(placed.status, JSON.stringify(placed.body).slice(0, 300)).toBeLessThan(300);
  return { id: placed.body.id, price, amount };
}

/** The TEST tier programme, its snapshot on the first whole minute at least `leadMs` from now. */
async function publishTiers(leadMs, reason) {
  const snapshotAt = new Date(Math.ceil((Date.now() + leadMs) / 60_000) * 60_000);
  const row = await publish(tiersAt(snapshotAt), reason);
  return { version: `v${row.version}`, snapshotAt };
}

/** The account's own fee tier read, as My tier shows it. */
async function myTier(client) {
  const { status, body } = await client.get('/api/v1/account/fee-tier');
  expect(status, JSON.stringify(body).slice(0, 300)).toBe(200);
  return body;
}

const tab = (page, name) => page.locator('[role=tab]', { hasText: new RegExp(`^${name}$`) });
const buyForm = (page) => page.locator('form[data-testid="dk-form"][data-side=buy]');
const feeLine = (page) => buyForm(page).locator('[data-testid="dk-fees"] > span').first();

/** The desk's own order check for the next change the person makes; returns its body. */
async function checkOf(page, act) {
  const answer = page.waitForResponse((r) => r.url().includes('/api/v1/orders/preview') && r.request().method() === 'POST');
  await act();
  const res = await answer;
  expect(res.status()).toBe(200);
  return res.json();
}

test(`${J} #1 previews a maker limit and a taker market: the fee line names the role and its rate, from the order check`, async ({
  page,
}) => {
  const who = await fundedTrader(page, 'js10', '5000');
  run.reset({ account: who });
  await openDesk(page, who);
  await page.mouse.move(0, 600);

  // A post-only limit can only rest: a maker, at the maker rate the order check answers.
  await tab(page, 'Limit').click();
  await page.getByRole('combobox', { name: 'Time in force' }).click();
  await page.getByRole('option', { name: 'Post only', exact: true }).click();
  // Well under the best bid, so it rests and nothing fills it.
  const restAt = await awayBid(95);
  await buyForm(page).getByRole('textbox', { name: 'Price' }).fill(restAt);
  const maker = await checkOf(page, () => buyForm(page).getByRole('textbox', { name: 'Amount' }).fill('0.001'));
  expect(maker).toMatchObject({ feeRole: 'maker' });
  expect(maker.feeBps).toEqual(expect.any(Number));
  await expect(feeLine(page)).toHaveText(`Fee ${pct(maker.feeBps)} · maker`);

  // A market order takes from the book: the line turns to the taker rate, again from the check.
  const taker = await checkOf(page, () => tab(page, 'Market').click());
  expect(taker).toMatchObject({ feeRole: 'taker' });
  expect(taker.feeBps).not.toBe(maker.feeBps);
  await expect(feeLine(page)).toHaveText(`Fee ${pct(taker.feeBps)} · taker`);
  // Nothing was sent: previewing holds nothing.
  expect(held(await (await api(who)).balances(), 'USDT')).toBe(0n);
});

test(`${J} #2 opens the public fee page: maker and taker by pair group and tier, a blank one "not set", the network fee apart`, async ({
  page,
}) => {
  await publish(SCHEDULE, 'TEST schedule by pair group and tier');
  const { status, body } = await published();
  expect(status).toBe(200);
  await page.goto('/fees');
  await expect(page.getByRole('heading', { level: 1, name: 'Trading fees' })).toBeVisible();
  await expect(page.getByText(`Schedule version ${body.version}`)).toBeVisible();

  const group = (name) => page.locator(`[data-pair-group="${name}"]`);
  const tier = (name, tierId) => group(name).locator(`tr[data-tier="${tierId}"] td`);
  // The default group, at each tier the page reads from the published schedule.
  await expect(group('all-others')).toContainText('BTC/USDT');
  await expect(tier('all-others', 'regular')).toHaveText([pct(8), pct(10)]);
  await expect(tier('all-others', 'test-vip-1')).toHaveText([pct(6), pct(9)]);
  // A zero-fee pair says so; the TEST VIP tier has no row in that group, so it reads "not set", not zero and not regular.
  await expect(group('test-zero-fee')).toContainText('ETH/USDC');
  await expect(tier('test-zero-fee', 'regular')).toHaveText(['Zero fee', 'Zero fee']);
  await expect(tier('test-zero-fee', 'test-vip-1')).toHaveText(['not set', 'not set']);
  // The network fee for sending a coin out is its own line, never inside a trading rate.
  await expect(page.locator('[data-fees="network"]')).toContainText('Network fee on withdrawals');

  // The page and the published read agree, row for row.
  for (const g of body.groups) {
    for (const tierId of body.tiers) {
      const row = g.rows.find((r) => r.tierId === tierId);
      const want = !row ? ['not set', 'not set'] : row.zeroFee ? ['Zero fee', 'Zero fee'] : [pct(row.makerBps), pct(row.takerBps)];
      await expect(tier(g.pairGroup, tierId)).toHaveText(want);
    }
  }
});

test(`${J} #3 orders on a market whose fee is blank: refused "Fee schedule not set" before anything is held`, async ({ page }) => {
  // Two schedule versions (blank, then restored) on top of the desk.
  test.setTimeout(180_000);
  const who = account();
  await publish(BLANK_IFC, 'IFC/USDT in a pair group with no row');
  try {
    await openDesk(page, who, 'IFC/USDT');
    await page.mouse.move(0, 600);
    await tab(page, 'Limit').click();
    await buyForm(page).getByRole('textbox', { name: 'Price' }).fill('0.95');
    // The order check names the blank schedule, and the ticket says so in words before anything is sent.
    const check = await checkOf(page, () => buyForm(page).getByRole('textbox', { name: 'Amount' }).fill('10'));
    expect(check.refusals.map((r) => r.code)).toContain('trade.fee_schedule_blank');
    expect(check.feeBps).toBeNull();
    await expect(buyForm(page)).toContainText('Fee schedule not set');
    await expect(buyForm(page).getByRole('button', { name: 'Buy IFC' })).toBeDisabled();

    // Sent anyway, straight to the API: refused by name, and nothing is held or rests.
    const client = await api(who);
    const before = await client.balances();
    const sent = await client.post('/api/v1/orders', {
      symbol: 'IFC/USDT',
      side: 'buy',
      type: 'limit',
      amount: '10',
      price: '0.95',
      clientOrderId: `js10-blank-${Date.now().toString(36)}`,
    });
    expect(sent.status, JSON.stringify(sent.body).slice(0, 300)).toBeGreaterThanOrEqual(400);
    expect(sent.status).toBeLessThan(500);
    expect(JSON.stringify(sent.body)).toContain('trade.fee_schedule_blank');
    const after = await client.balances();
    expect(held(after, 'USDT')).toBe(0n);
    expect(after.USDT?.free).toBe(before.USDT?.free);
    expect(await openOrders(who, 'IFC/USDT')).toHaveLength(0);
  } finally {
    // IFC/USDT goes back to the default group, so nothing after this step finds it blank.
    await publish(SCHEDULE, 'IFC/USDT back in the default pair group');
  }
});

test(`${J} #4 fills on a zero-fee pair and a rebate pair: "Zero fee" on one, a maker rebate on the other, never a negative fee`, async ({
  page,
}) => {
  // A schedule version (and its restore) on top of two fills and two desks.
  test.setTimeout(240_000);
  const who = account();
  const client = await api(who);

  // Zero fee: ETH/USDC is in the TEST zero-fee group. An IOC buy at the best ask takes from the house quote.
  fund(who.email, 'USDC', '100');
  const { ask } = await bestPrices('ETH/USDC');
  const zero = await client.post('/api/v1/orders', {
    symbol: 'ETH/USDC',
    side: 'buy',
    type: 'limit',
    amount: '0.01',
    price: ask,
    timeInForce: 'IOC',
    clientOrderId: `js10-zero-${Date.now().toString(36)}`,
  });
  expect(zero.status, JSON.stringify(zero.body).slice(0, 300)).toBeLessThan(300);
  const [zeroFill] = await fillsOf(client, 'ETH/USDC', zero.body.id);
  expect(zeroFill.takerOrMaker).toBe('taker');
  expect(toUnits(zeroFill.fee.cost)).toBe(0n);
  expect(zeroFill.rebate).toBeUndefined();
  await openDesk(page, who, 'ETH/USDC');
  await tab(page, 'Trade history').click();
  await expect(page.locator(`tr[data-fill="${zeroFill.id}"] [data-fee=zero]`)).toHaveText('Zero fee');

  await publish(REBATE_IFC, 'IFC/USDT in a TEST rebate group');
  try {
    // The ticket says what a resting order earns, from the order check: a rebate, not a fee and not a minus sign.
    // Already signed in from the ETH/USDC desk, so the person opens the next market straight away.
    await page.goto(deskPath('IFC/USDT'));
    await expect(page.getByRole('button', { name: 'Buy IFC' })).toBeVisible();
    await page.mouse.move(0, 600);
    await tab(page, 'Limit').click();
    await page.getByRole('combobox', { name: 'Time in force' }).click();
    await page.getByRole('option', { name: 'Post only', exact: true }).click();
    const { bid, ask: ifcAsk } = await bestPrices('IFC/USDT');
    // Inside the spread, so it rests ahead of the house bids and a crossing sell reaches it first.
    const price = fromUnits(toUnits(bid) + ((toUnits(ifcAsk) - toUnits(bid)) / 2n / 10n ** 14n) * 10n ** 14n);
    const amount = '200';
    await buyForm(page).getByRole('textbox', { name: 'Price' }).fill(price);
    const check = await checkOf(page, () => buyForm(page).getByRole('textbox', { name: 'Amount' }).fill(amount));
    expect(check).toMatchObject({ feeRole: 'maker', feeBps: 0, makerRebateBps: 5 });
    await expect(feeLine(page)).toHaveText(`Rebate up to ${pct(5)} · maker`);

    const before = await client.balances();
    const placed = await client.post('/api/v1/orders', {
      symbol: 'IFC/USDT',
      side: 'buy',
      type: 'limit',
      amount,
      price,
      timeInForce: 'PO',
      clientOrderId: `js10-rebate-${Date.now().toString(36)}`,
    });
    expect(placed.status, JSON.stringify(placed.body).slice(0, 300)).toBeLessThan(300);
    const id = placed.body.id;

    await sellInto(who, { id, price, amount }, `${J}-4-${id}`);

    // Every fill of the order: a maker, no fee, and a rebate in the USDT the maker paid, at 0.05% rounded down.
    const fills = await fillsOf(client, 'IFC/USDT', id);
    let paid = 0n;
    let back = 0n;
    for (const fill of fills) {
      expect(fill.takerOrMaker).toBe('maker');
      expect(toUnits(fill.fee.cost)).toBe(0n);
      expect(fill.rebate).toMatchObject({ currency: 'USDT', rate: '0.0005' });
      const rebate = toUnits(fill.rebate.cost);
      expect(rebate).toBeGreaterThan(0n);
      expect(rebate).toBeLessThanOrEqual(times(fill.cost, '0.0005'));
      expect(rebate).toBeGreaterThan(times(fill.cost, '0.0004'));
      paid += toUnits(fill.cost);
      back += rebate;
    }
    // The ledger agrees: the buyer paid price x amount, got the rebate back, and holds nothing.
    await expect
      .poll(async () => toUnits((await client.balances()).USDT.total) - toUnits(before.USDT.total), { timeout: 20_000 })
      .toBe(back - paid);
    const after = await client.balances();
    expect(held(after, 'USDT')).toBe(0n);
    expect(toUnits(after.IFC.total) - toUnits(before.IFC?.total ?? '0')).toBe(toUnits(amount));

    // The trade history shows it as a rebate, never as a negative fee (a fresh desk reads the settled fills at once).
    await page.reload();
    await expect(page.getByRole('button', { name: 'Buy IFC' })).toBeVisible();
    await tab(page, 'Trade history').click();
    const row = page.locator(`tr[data-fill="${fills[0].id}"]`);
    await expect(row.locator('[data-fee=zero]')).toContainText('Zero fee');
    await expect(row.getByTestId('dk-rebate')).toContainText(/Rebate 0\.\d+ USDT/);
    await expect(row.getByTestId('dk-rebate')).toContainText(pct(5));
    await expect(row).not.toContainText(/-\s*0\.\d/);
  } finally {
    await publish(SCHEDULE, 'IFC/USDT back in the default pair group');
  }
});

test(`${J} #5 opens My tier: the tier, the volume counted and from what, what is excluded, and the next threshold`, async ({ page }) => {
  // Two schedule versions (the programme, then none) around a page.
  test.setTimeout(180_000);
  const who = account();
  const client = await api(who);
  const { snapshotAt } = await publishTiers(120_000, `TEST tier programme, VIP from ${VIP_FROM}`);
  try {
    // The volume counted is the person's own spot fills quoted in USDT or USDC: the ones #4 made, nothing invented.
    let own = 0n;
    let count = 0;
    for (const symbol of ['BTC/USDT', 'ETH/USDC', 'IFC/USDT']) {
      const { body } = await client.get(`/api/v1/account/trades?symbol=${encodeURIComponent(symbol)}&limit=100`);
      for (const fill of Array.isArray(body) ? body : (body.trades ?? [])) {
        own += toUnits(fill.cost);
        count += 1;
      }
    }
    const tier = await myTier(client);
    expect(toUnits(tier.volume.amount)).toBe(own);
    expect(tier.volume.fills).toBe(count);
    expect(count).toBeGreaterThan(0);
    expect(own).toBeLessThan(toUnits(VIP_FROM));
    expect(tier).toMatchObject({
      tier: 'regular',
      lastSnapshot: null,
      volume: { reaches: 'regular' },
      next: { tierId: 'test-vip-1', minVolume30d: VIP_FROM },
      snapshotsRunning: true,
      nextSnapshotAt: snapshotAt.toISOString(),
      snapshots: [],
    });
    expect(toUnits(tier.next.remaining)).toBe(toUnits(VIP_FROM) - own);
    expect(tier.excluded).toEqual(expect.arrayContaining(['futures_and_options', 'bots_and_copy', 'sub_accounts', 'assets']));

    await signIn(page, who);
    await page.goto('/fees/my-tier');
    await expect(page.getByRole('heading', { level: 1, name: 'My fee tier' })).toBeVisible();
    await expect(page.locator('h2[data-tier=regular]')).toHaveText('Your tier: Regular');
    await expect(page.locator(`[data-volume="${tier.volume.amount}"]`)).toHaveText(
      `${tier.volume.amount} counted toward the next snapshot so far, from ${count} trades`,
    );
    await expect(page.locator('[data-reaches=regular]')).toHaveText('At the next snapshot this volume reaches: Regular');
    await expect(page.locator('[data-tier-page=next]')).toHaveText(`Next tier: test-vip-1 from ${VIP_FROM}, ${tier.next.remaining} to go`);
    await expect(page.locator('tr[data-threshold=test-vip-1] td')).toHaveText(VIP_FROM);
    // What counts, and what does not: the asset input is named as not counted, never left out.
    await expect(page.locator('[data-counted=spot]')).toContainText('quoted in USDT, USDC');
    for (const code of tier.excluded) await expect(page.locator(`[data-excluded=${code}]`)).toBeVisible();
    await expect(page.locator('[data-excluded=assets]')).toHaveText('Assets you hold: not counted (no asset thresholds set).');
    await expect(page.locator(`[data-next-snapshot="${snapshotAt.toISOString()}"]`)).toContainText(
      `Next snapshot: ${snapshotAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    );
    await expect(page.locator('[data-tier-page=snapshots]')).toContainText('No snapshot has included you yet.');
  } finally {
    await publish(SCHEDULE, 'tier programme off');
  }
  // With no programme every account is regular, and the page says the thresholds are not set.
  expect(await myTier(client)).toMatchObject({ tier: 'regular', program: null, volume: null, next: null });
  await page.reload();
  await expect(page.locator('[data-tier-page=thresholds-not-set]')).toHaveText('Thresholds not set. Every account is on the regular tier.');
});

test(`${J} #6 crosses the threshold during the day: the tier changes at the next snapshot, and its row shows the figures`, async ({
  page,
}) => {
  // Two schedule versions, a fill, and a wait of up to three minutes for the snapshot.
  test.setTimeout(360_000);
  const who = account();
  const client = await api(who);
  const { version, snapshotAt } = await publishTiers(150_000, `TEST tier programme, VIP from ${VIP_FROM}, snapshot due`);
  const deskCheck = async () => {
    await page.goto(deskPath());
    await expect(page.getByRole('button', { name: 'Buy BTC' })).toBeVisible();
    await page.mouse.move(0, 600);
    await tab(page, 'Limit').click();
    await page.getByRole('combobox', { name: 'Time in force' }).click();
    await page.getByRole('option', { name: 'Post only', exact: true }).click();
    await buyForm(page)
      .getByRole('textbox', { name: 'Price' })
      .fill(await awayBid(95));
    return checkOf(page, () => buyForm(page).getByRole('textbox', { name: 'Amount' }).fill('0.001'));
  };
  try {
    // A market buy on BTC/USDT for more than the rest of the threshold, during the day.
    fund(who.email, 'USDT', '2000');
    let now = await myTier(client);
    expect(now.tier).toBe('regular');
    for (let attempt = 0; attempt < 3 && now.volume.reaches === 'regular'; attempt += 1) {
      const { ask } = await bestPrices('BTC/USDT');
      const want = toUnits(now.next.remaining) + toUnits('25');
      const step = 10n ** 13n; // 0.00001 BTC
      const amount = fromUnits(((want * 10n ** 18n) / toUnits(ask) / step + 1n) * step);
      const bought = await client.post('/api/v1/orders', {
        symbol: 'BTC/USDT',
        side: 'buy',
        type: 'market',
        amount,
        clientOrderId: `js10-tier-${attempt}-${Date.now().toString(36)}`,
      });
      expect(bought.status, JSON.stringify(bought.body).slice(0, 300)).toBeLessThan(300);
      await fillsOf(client, 'BTC/USDT', bought.body.id);
      const was = toUnits(now.volume.amount);
      await expect.poll(async () => toUnits((now = await myTier(client)).volume.amount) > was, { timeout: 30_000 }).toBe(true);
    }
    // The volume reaches the TEST VIP tier, but the tier stays regular until the snapshot: never mid-day.
    expect(now).toMatchObject({ tier: 'regular', volume: { reaches: 'test-vip-1' }, next: null, nextSnapshotAt: snapshotAt.toISOString() });
    expect(Date.now()).toBeLessThan(snapshotAt.getTime());
    await signIn(page, who);
    await page.goto('/fees/my-tier');
    await expect(page.locator('h2[data-tier=regular]')).toHaveText('Your tier: Regular');
    await expect(page.locator('[data-reaches=test-vip-1]')).toHaveText('At the next snapshot this volume reaches: test-vip-1');
    // A new order before the snapshot is still checked at the regular maker rate.
    expect(await deskCheck()).toMatchObject({ feeRole: 'maker', feeBps: 8, feeTier: 'regular' });

    // The snapshot runs at its minute and the tier changes; its row keeps the figures it used.
    await expect
      .poll(async () => (await myTier(client)).tier, { timeout: snapshotAt.getTime() - Date.now() + 90_000, intervals: [5_000] })
      .toBe('test-vip-1');
    const after = await myTier(client);
    expect(after.lastSnapshot).toMatchObject({
      instant: snapshotAt.toISOString(),
      tierId: 'test-vip-1',
      volume30d: now.volume.amount,
      countedFills: now.volume.fills,
      scheduleVersion: version,
    });
    expect(after.lastSnapshot.key).toMatch(new RegExp(`^tier-snapshot:${snapshotAt.toISOString().slice(0, 16)}Z:`));
    expect(after.snapshots[0]).toEqual(after.lastSnapshot);

    await page.goto('/fees/my-tier');
    await expect(page.locator('h2[data-tier=test-vip-1]')).toHaveText('Your tier: test-vip-1');
    const minute = `${snapshotAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
    await expect(page.locator('[data-tier-page=tier]')).toContainText(`From the snapshot at ${minute}.`);
    const row = page.locator(`tr[data-snapshot="${after.lastSnapshot.key}"]`);
    await expect(row.locator('th')).toHaveText(minute);
    await expect(row.locator('td')).toHaveText(['test-vip-1', now.volume.amount, String(now.volume.fills), version]);

    // A new order is now checked at the TEST VIP maker rate.
    const check = await deskCheck();
    expect(check).toMatchObject({ feeRole: 'maker', feeBps: 6, feeTier: 'test-vip-1' });
    await expect(feeLine(page)).toHaveText(`Fee ${pct(6)} · maker`);
  } finally {
    await publish(SCHEDULE, 'tier programme off');
  }
});

/** A TEST benefits table, never owner values: the VIP tier fills some cells, the regular tier none. */
const NOT_SET = { prioritySupport: null, vipPortal: null, ambassador: null, subAccountCap: null, withdrawalLimit24h: null };
const TEST_BENEFITS = [
  { tierId: 'regular', ...NOT_SET },
  {
    ...NOT_SET,
    tierId: 'test-vip-1',
    prioritySupport: true,
    vipPortal: false,
    subAccountCap: 20,
    withdrawalLimit24h: { asset: 'USDT', amount: '250000' },
  },
];

test(`${J} part of #7 opens VIP benefits: each tier's published benefits, the person's own tier marked, a blank cell "not set"`, async ({
  page,
}) => {
  test.setTimeout(150_000);
  const who = account();
  const client = await api(who);
  const tiered = tiersAt(new Date(Date.now() + 3_600_000));
  await publish({ ...tiered, tierProgram: { ...tiered.tierProgram, benefits: TEST_BENEFITS } }, 'TEST benefits table');
  try {
    const read = await myTier(client);
    expect(read.program.benefits).toEqual(TEST_BENEFITS);
    // The person's tier is whatever their last snapshot gave (#6 may have raised it): their row is the one marked.
    const mine = read.tier;
    const label = (tierId) => (tierId === 'regular' ? 'Regular' : tierId);
    await signIn(page, who);
    await page.goto('/fees/my-tier');
    const table = page.locator('[data-tier-page=benefits]');
    await expect(table.getByRole('heading', { level: 2, name: 'VIP benefits' })).toBeVisible();
    await expect(table.locator('tr[aria-current=true]')).toHaveAttribute('data-benefits', mine);
    await expect(table.locator(`tr[data-benefits="${mine}"] th`)).toHaveText(`${label(mine)} (yours)`);
    const regular = table.locator('tr[data-benefits=regular]');
    await expect(regular.locator('td')).toHaveText(['not set', 'not set', 'not set', 'not set', 'not set']);
    const vip = table.locator('tr[data-benefits=test-vip-1]');
    await expect(vip.locator('td')).toHaveText(['Yes', 'No', 'not set', '20', 'up to 250000 USDT']);
  } finally {
    await publish(SCHEDULE, 'benefits table off');
  }
  // With no programme there is no table, and the page says so.
  await page.reload();
  await expect(page.locator('[data-benefits=not-set]')).toHaveText('Benefits not set: no tier has published benefits beyond its rates.');
});

/** TEST application rules, never owner values: PDF or PNG proofs up to 256 KB. */
const TEST_APPLICATION = { proofTypes: ['application/pdf', 'image/png'], maxBytes: 256 * 1024 };
/** A TEST proof: the smallest well-formed PDF header and a line naming it TEST. */
const TEST_PDF = Buffer.from('%PDF-1.4\n% TEST proof of VIP status elsewhere, not a real statement\n%%EOF\n');

test(`${J} part of #7 applies with a proof file: a type not accepted is refused naming the accepted ones, a PDF waits for review`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  // Its own fresh applicant: an application is never deleted, so a step re-run alone must not meet the last one.
  const who = await signUp(page, 'vipapply');
  await verify(page, who);
  const client = await api(who);
  const tiered = tiersAt(new Date(Date.now() + 3_600_000));
  await publish({ ...tiered, tierProgram: { ...tiered.tierProgram, application: TEST_APPLICATION } }, 'TEST VIP application rules');
  try {
    const before = await client.get('/api/v1/vip/applications');
    expect(before.status, JSON.stringify(before.body).slice(0, 300)).toBe(200);
    expect(before.body).toEqual({ rules: TEST_APPLICATION, closed: null, applications: [] });
    await signIn(page, who);
    await page.goto('/fees/my-tier');
    const card = page.locator('[data-tier-page=vip-apply]');
    await expect(card.getByRole('heading', { level: 2, name: 'Apply for a VIP tier' })).toBeVisible();
    await expect(card.locator('[data-vip=rules]')).toHaveText('Accepted files: PDF, PNG, up to 256 KB.');
    await expect(card.locator('[data-vip=none]')).toHaveText('You have not applied.');
    const file = card.getByLabel('Proof file');
    const send = card.getByRole('button', { name: 'Send application' });

    // A type the owner does not accept: the service refuses it and the card names what is accepted.
    await file.setInputFiles({ name: 'statement.txt', mimeType: 'text/plain', buffer: Buffer.from('TEST statement') });
    let answer = page.waitForResponse((r) => r.url().endsWith('/api/v1/vip/applications') && r.request().method() === 'POST');
    await send.click();
    expect((await answer).status()).toBe(400);
    await expect(card.locator('[data-vip-result=refused]')).toHaveText('Not sent: text/plain is not an accepted file. Accepted: PDF, PNG.');

    // Named a PDF but not one: refused by its bytes, not its name.
    await file.setInputFiles({ name: 'statement.pdf', mimeType: 'application/pdf', buffer: Buffer.from('TEST not a pdf') });
    answer = page.waitForResponse((r) => r.url().endsWith('/api/v1/vip/applications') && r.request().method() === 'POST');
    await send.click();
    expect((await answer).status()).toBe(400);
    await expect(card.locator('[data-vip-result=refused]')).toHaveText('Not sent: this file is not a PDF. Accepted: PDF, PNG.');
    expect((await client.get('/api/v1/vip/applications')).body.applications).toEqual([]);

    // A PDF: kept, waiting for review, and the form gives way to the waiting line.
    await file.setInputFiles({ name: 'statement.pdf', mimeType: 'application/pdf', buffer: TEST_PDF });
    await card.getByLabel('Note for the reviewer (optional)').fill('TEST: VIP at another venue');
    answer = page.waitForResponse((r) => r.url().endsWith('/api/v1/vip/applications') && r.request().method() === 'POST');
    await send.click();
    expect((await answer).status()).toBe(201);
    await expect(card.locator('[data-vip-result=sent]')).toHaveText('Application sent: statement.pdf is waiting for review.');
    await expect(card.locator('[data-vip=waiting]')).toBeVisible();
    await expect(card.locator('form')).toHaveCount(0);
    await expect(card.locator('tr[data-vip-application=pending] td').last()).toHaveText('Waiting for review');

    // The person's read is metadata: the file's name, type, size and digest, never its bytes.
    const after = await client.get('/api/v1/vip/applications');
    expect(after.body.applications).toHaveLength(1);
    const [kept] = after.body.applications;
    expect(kept).toMatchObject({
      status: 'pending',
      note: 'TEST: VIP at another venue',
      proof: {
        fileName: 'statement.pdf',
        contentType: 'application/pdf',
        byteLength: TEST_PDF.length,
        sha256: createHash('sha256').update(TEST_PDF).digest('hex'),
      },
    });
    expect(JSON.stringify(after.body)).not.toContain(TEST_PDF.toString('base64'));
  } finally {
    await publish(SCHEDULE, 'application rules off');
  }
  // With no rules published, applications are not open, and the waiting application is still listed.
  await page.reload();
  const card = page.locator('[data-tier-page=vip-apply]');
  await expect(card.locator('[data-vip=not-open]')).toHaveText('Applications are not open: no accepted proof file is published.');
  await expect(card.locator('tr[data-vip-application=pending]')).toHaveCount(1);
});

test(`${J} part of #7 compliance approves with no trial published: the grant is refused vip.trial_unset, then granted once one is`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  // Its own fresh applicant, as above.
  const who = await signUp(page, 'vipreview');
  await verify(page, who);
  const client = await api(who);
  const { ctx, sessions } = await ops();
  const tiered = tiersAt(new Date(Date.now() + 3_600_000));
  // The application rules are published and no trial is: an approval can grant none.
  await publish({ ...tiered, tierProgram: { ...tiered.tierProgram, application: TEST_APPLICATION } }, 'TEST VIP rules, no trial');
  let applicationId;
  try {
    const sent = await client.post('/api/v1/vip/applications', {
      requestId: `vip-review-${Date.now()}`,
      proof: { fileName: 'statement.pdf', contentType: 'application/pdf', bytesBase64: TEST_PDF.toString('base64') },
    });
    expect(sent.status, JSON.stringify(sent.body).slice(0, 300)).toBe(201);
    applicationId = sent.body.application.id;

    // Two TEST operators: one proposes the approval at identity, the other approves it, the first applies it.
    const reviewed = await reviewVipApplication(ctx, { applicationId, decision: 'approve', sessions });
    const decided = reviewed.json?.result?.data;
    expect(decided, JSON.stringify(reviewed.json).slice(0, 400)).toBeTruthy();
    expect(decided.application).toMatchObject({ id: applicationId, status: 'approved_no_trial', trial: null });
    expect(decided.trialRefusal).toBe('vip.trial_unset');
    const approval = decided.application.events.at(-1);
    expect(approval).toMatchObject({ status: 'approved_no_trial', actorRole: 'compliance' });
    expect(approval.approverId).toBeTruthy();
    expect(approval.approverId).not.toBe(approval.actorId);

    // Granting the trial is refused by name, and the application stays as it was.
    const grant = await grantVipTrial(ctx, { applicationId, sessions });
    expect(grant.json?.error?.data?.cause?.code, JSON.stringify(grant.json).slice(0, 400)).toBe('vip.trial_unset');
    const mine = await client.get('/api/v1/vip/applications');
    expect(mine.body.applications.map((a) => [a.id, a.status])).toEqual([[applicationId, 'approved_no_trial']]);

    // The person sees the decision on My tier, and stays on the tier their volume gives.
    await signIn(page, who);
    await page.goto('/fees/my-tier');
    const card = page.locator('[data-tier-page=vip-apply]');
    await expect(card.locator('tr[data-vip-application=approved_no_trial] td').last()).toHaveText('Approved, no trial period set');
    await expect(page.locator('[data-tier-page=tier] h2')).toHaveText('Your tier: Regular');
    await expect(page.locator('[data-tier-page=trial]')).toHaveCount(0);

    // Once the owner publishes a trial, the grant goes through with its own approval: the tier is the trial's until it ends.
    const trial = { tierId: 'test-vip-1', days: 1 };
    await publish({ ...tiered, tierProgram: { ...tiered.tierProgram, application: TEST_APPLICATION, trial } }, 'TEST VIP trial');
    const granted = await grantVipTrial(ctx, { applicationId, sessions });
    const after = granted.json?.result?.data;
    expect(after, JSON.stringify(granted.json).slice(0, 400)).toBeTruthy();
    expect(after.application).toMatchObject({ status: 'approved', trial: { tierId: 'test-vip-1', days: 1 } });
    const tier = await myTier(client);
    expect(tier.tier).toBe('test-vip-1');
    expect(tier.trial).toMatchObject({ applicationId, tierId: 'test-vip-1', endsAt: after.application.trial.endsAt });
    await page.reload();
    await expect(page.locator('[data-tier-page=tier] h2')).toHaveText('Your tier: test-vip-1');
    await expect(page.locator('[data-tier-page=trial]')).toContainText('From your VIP trial, until ');
    await expect(card.locator('tr[data-vip-application=approved] td').last()).toHaveText('Approved');
  } finally {
    await publish(SCHEDULE, 'VIP rules off');
  }
});

test(`${J} part of #7 compliance decides in the founder console: the proof saved for a reason, a second founder approves, the trial starts`, async ({
  page,
  browser,
}) => {
  test.setTimeout(300_000);
  // Its own fresh applicant, as above, with a TEST one-day trial published, so an approval grants it.
  const who = await signUp(page, 'vipdesk');
  await verify(page, who);
  const client = await api(who);
  const tiered = tiersAt(new Date(Date.now() + 3_600_000));
  const trial = { tierId: 'test-vip-1', days: 1 };
  await publish({ ...tiered, tierProgram: { ...tiered.tierProgram, application: TEST_APPLICATION, trial } }, 'TEST VIP trial for the desk');
  const a = await (await browser.newContext({ acceptDownloads: true })).newPage();
  const b = await (await browser.newContext()).newPage();
  try {
    const sent = await client.post('/api/v1/vip/applications', {
      requestId: `vip-desk-${Date.now()}`,
      proof: { fileName: 'statement.pdf', contentType: 'application/pdf', bytesBase64: TEST_PDF.toString('base64') },
    });
    expect(sent.status, JSON.stringify(sent.body).slice(0, 300)).toBe(201);
    const applicationId = sent.body.application.id;

    // Founder A opens the room: what an approval grants now, and the application waiting.
    await founderSignIn(a, 'a');
    await a.goto(`${ADMIN}/trade-ops/vip-applications`);
    const room = a.locator('[data-room=vip-applications]');
    await expect(room).toContainText('An approval grants now');
    await expect(room).toContainText('test-vip-1 for 1 day');
    const row = room.getByRole('row').filter({ hasText: client.userId });
    await expect(row).toContainText('Waiting for review');
    await row.getByRole('button', { name: 'Open' }).click();
    const panel = a.locator('[data-vip-desk=open]');
    await expect(panel).toContainText(`Application ${applicationId}`);

    // The proof is saved, never shown, and only for a stated reason: the bytes are the ones the person sent.
    const reason = 'TEST statement checked against the venue';
    await panel.getByLabel(/^Reason \(12 to 500/).fill(reason);
    const [download] = await Promise.all([a.waitForEvent('download'), panel.getByRole('button', { name: 'Save the proof file' }).click()]);
    expect(download.suggestedFilename()).toBe('statement.pdf');
    const saved = await download.path();
    expect(createHash('sha256').update(readFileSync(saved)).digest('hex')).toBe(createHash('sha256').update(TEST_PDF).digest('hex'));
    await expect(panel).toContainText('The opening is in the audit.');

    // A asks for the approval; applying it before a second founder approves decides nothing.
    await panel.getByRole('button', { name: 'Ask a second founder to approve' }).click();
    await expect(panel).toContainText('Request filed');
    const valueOf = (label) => panel.locator('dt', { hasText: label }).locator('xpath=following-sibling::dd[1]');
    const approvalId = (await valueOf('Approval id (apply with this once approved)').innerText()).trim();
    const payloadHash = (await valueOf('Payload hash (the approver confirms this)').innerText()).trim();
    expect(payloadHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    await panel.getByLabel('Approved request id').fill(approvalId);
    const apply = async () => {
      await panel.getByRole('button', { name: 'Apply the approved decision' }).click();
      const dialog = a.getByRole('alertdialog');
      await expect(dialog).toContainText('the person is on test-vip-1 for 1 day, from now');
      await dialog.getByRole('button', { name: 'Apply decision' }).click();
      return dialog;
    };
    const early = await apply();
    await expect(early).toContainText('still waiting for a second founder');
    await early.getByRole('button', { name: 'Cancel' }).click();
    expect((await client.get('/api/v1/vip/applications')).body.applications.map((x) => x.status)).toEqual(['pending']);

    // Founder B first checks what the request is: the same decision and reason in the room give the same hash.
    const approver = await founderSignIn(b, 'b');
    await b.goto(`${ADMIN}/trade-ops/vip-applications`);
    await b
      .locator('[data-room=vip-applications]')
      .getByRole('row')
      .filter({ hasText: client.userId })
      .getByRole('button', { name: 'Open' })
      .click();
    const bPanel = b.locator('[data-vip-desk=open]');
    await bPanel.getByLabel(/^Reason \(12 to 500/).fill(reason);
    await bPanel.getByRole('button', { name: 'Work out the hash to check' }).click();
    await expect(bPanel.locator('[data-vip-desk=check]')).toContainText(payloadHash);
    await expect(bPanel.locator('[data-vip-desk=check]')).toContainText('test-vip-1 for 1 day');

    // B approves exactly that hash in Freezes & approvals; A applies it.
    await b.goto(`${ADMIN}/trade-ops/approvals`);
    await b.getByLabel('Approval id', { exact: true }).fill(approvalId);
    await b.getByLabel('Payload hash you reviewed').fill(payloadHash);
    await b.getByRole('button', { name: 'Approve request' }).click();
    const approveDialog = b.getByRole('alertdialog');
    await approveDialog.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(approveDialog.locator('[data-outcome=ok]')).toBeVisible();

    // Applied: the panel stays open on the decided application and says what was done.
    await apply();
    await expect(panel.locator('[data-vip-desk=applied]')).toContainText('Applied: approved, on test-vip-1 until ');
    await expect(panel).toContainText('Approved');
    await expect(panel).toContainText(`approved by ${approver.userId}`);
    await expect(panel).toContainText(/test-vip-1, 1 days?, /);

    // The person is on the trial's tier until it ends.
    const tier = await myTier(client);
    expect(tier.tier).toBe('test-vip-1');
    expect(tier.trial).toMatchObject({ applicationId, tierId: 'test-vip-1' });
    await signIn(page, who);
    await page.goto('/fees/my-tier');
    await expect(page.locator('[data-tier-page=tier] h2')).toHaveText('Your tier: test-vip-1');
    await expect(page.locator('[data-tier-page=trial]')).toContainText('From your VIP trial, until ');
  } finally {
    await a.context().close();
    await b.context().close();
    await publish(SCHEDULE, 'VIP rules off');
  }
});

test(`${J} #8 looks at the fee currency row: disabled with its reason, and no request is sent`, async ({ page }) => {
  const who = account();
  // Every request the desk sends that names a fee currency: there must be none.
  const named = [];
  page.on('request', (req) => {
    if (`${req.url()} ${req.postData() ?? ''}`.includes('feeCurrency')) named.push(`${req.method()} ${new URL(req.url()).pathname}`);
  });
  await openDesk(page, who);
  await page.mouse.move(0, 600);
  const row = buyForm(page).locator('[data-fee-currency]');
  // The fee comes out of what the order receives: BTC on a buy, USDT on a sell.
  await expect(row).toHaveAttribute('data-fee-currency', 'BTC');
  await expect(row).toContainText('Fees in BTC');
  const choice = row.getByRole('button', { name: 'Pay fees in another asset' });
  await expect(choice).toBeDisabled();
  await expect(choice).toHaveAccessibleDescription(
    'Not offered now: no fee token terms are published. The fee comes out of the BTC this order receives.',
  );
  // It stays reachable from the keyboard, and pressing or clicking it does nothing.
  await choice.focus();
  await expect(choice).toBeFocused();
  await page.keyboard.press('Enter');
  await choice.click({ force: true });
  await expect(page.locator('form[data-testid="dk-form"][data-side=sell] [data-fee-currency]')).toContainText('Fees in USDT');
  // Long enough for a request the click started to have been sent.
  await page.waitForTimeout(1_500);
  expect(named).toEqual([]);

  // The service says the same thing to a caller who sends one anyway, and holds nothing.
  const client = await api(who);
  const before = held(await client.balances(), 'USDT');
  const clientOrderId = `js10-fee-currency-${Date.now().toString(36)}`;
  const sent = await client.post('/api/v1/orders', {
    symbol: 'BTC/USDT',
    side: 'buy',
    type: 'limit',
    amount: '0.001',
    price: await awayBid(95),
    feeCurrency: 'IFC',
    clientOrderId,
  });
  expect(sent.status).toBe(400);
  expect(JSON.stringify(sent.body)).toContain('trade.fee_currency_ifc_unset');
  expect(held(await client.balances(), 'USDT')).toBe(before);
  expect((await openOrders(who, 'BTC/USDT')).filter((o) => o.clientOrderId === clientOrderId)).toEqual([]);
});

/**
 * TEST terms for #9, not owner prices: one BTC is worth 100 000 IFC and one USDT 2 IFC. With the stack's taker 0.10%, a
 * buy of 0.001 BTC owes 0.000001 BTC, which is 0.1 IFC before the stake discount.
 */
const IFC_TERMS = { tokenAsset: 'IFC', perUnit: { BTC: '100000', USDT: '2' } };
/** TEST stake-discount ladder: nothing off below 100 IFC staked, 20% off from 100. Not an owner decision. */
const TEST_LADDER = {
  basis: 'staked',
  tiers: [
    { minStake: '0', discountBps: 0 },
    { minStake: '100', discountBps: 2000 },
  ],
};

test(`${J} #9 chooses to pay trading fees in IFC: the published discount with its decay, the fee posting in IFC`, async ({ page }) => {
  // A ladder, a stake, a schedule version and its restore around one desk order.
  test.setTimeout(240_000);
  const who = account();
  const client = await api(who);
  const { ctx, sessions } = await ops();
  await setFeeDiscountSchedule(ctx, TEST_LADDER, { sessions });
  // A TEST stake of 100 IFC puts the account on the 20% step.
  fund(who.email, 'IFC', '150');
  const staked = await client.post('/api/token/trpc/stake', { amount: '100', tier: 'flex', stakeId: randomUUID() });
  expect(staked.status, JSON.stringify(staked.body).slice(0, 300)).toBe(200);

  await publish({ ...SCHEDULE, ifcFee: IFC_TERMS }, 'TEST terms for paying fees in IFC');
  try {
    expect((await published()).body.feeToken).toEqual({ asset: 'IFC', perUnit: IFC_TERMS.perUnit });
    const sent = placements(page);
    await openDesk(page, who);
    await page.mouse.move(0, 600);
    await tab(page, 'Market').click();
    await checkOf(page, () => buyForm(page).getByRole('textbox', { name: 'Amount' }).fill('0.001'));

    // Offered, with the person's own discount and the published ladder it comes from.
    const row = buyForm(page).locator('[data-fee-currency]');
    await expect(row).toHaveAttribute('data-fee-token', 'offered', { timeout: 20_000 });
    const choice = row.getByRole('button', { name: 'Pay fees in IFC' });
    await expect(choice).toHaveAttribute('aria-pressed', 'false');
    await expect(row).toContainText('Fees in BTC');
    await expect(row).toContainText(`Pay this fee in IFC instead, ${pct(2000)} off with your stake.`);
    await expect(row.locator('[data-fee-ladder]')).toHaveText(`Discount by stake: from 0 IFC ${pct(0)}, from 100 IFC ${pct(2000)}.`);
    await choice.click();
    await expect(choice).toHaveAttribute('aria-pressed', 'true');
    await expect(row).toHaveAttribute('data-fee-currency', 'IFC');
    await expect(row).toContainText('Fees in IFC');
    await expect(row).toContainText(/If your IFC is short when it fills, the fee comes out of the BTC instead\./);

    const before = await client.balances();
    await page.getByRole('button', { name: 'Buy BTC' }).click();
    const review = reviewSheet(page);
    await expect(review).toBeVisible();
    await expect(review.locator('[data-review-fee-currency=IFC]')).toContainText(`IFC, ${pct(2000)} off with your stake`);
    await confirm(page, 'buy');
    expect(sent.at(-1)).toMatchObject({ symbol: 'BTC/USDT', side: 'buy', type: 'market', amount: '0.001', feeCurrency: 'IFC' });

    // Every fill took its fee in IFC: 0.10% of the BTC, at 100 000 IFC a BTC, 20% off. All 0.001 BTC arrived.
    let order;
    await expect
      .poll(
        async () => {
          const { body } = await client.get('/api/v1/orders/closed?symbol=BTC%2FUSDT&limit=20');
          order = (Array.isArray(body) ? body : []).find((o) => o.clientOrderId === sent.at(-1).clientOrderId);
          return order?.status ?? null;
        },
        { timeout: 30_000 },
      )
      .toBe('closed');
    const fills = await fillsOf(client, 'BTC/USDT', order.id);
    let feeIfc = 0n;
    let bought = 0n;
    for (const fill of fills) {
      expect(fill.fee.currency).toBe('IFC');
      expect(fill.feeFallback).toBeUndefined();
      expect(toUnits(fill.fee.cost)).toBe(times(fill.amount, '80'));
      feeIfc += toUnits(fill.fee.cost);
      bought += toUnits(fill.amount);
    }
    expect(bought).toBe(toUnits('0.001'));
    expect(feeIfc).toBe(toUnits('0.08'));
    // The ledger agrees: the IFC fee left once, and the BTC came in whole.
    await expect.poll(async () => free(await client.balances(), 'IFC'), { timeout: 20_000 }).toBe(free(before, 'IFC') - feeIfc);
    const after = await client.balances();
    expect(toUnits(after.BTC.total) - toUnits(before.BTC?.total ?? '0')).toBe(bought);

    // Trade history shows the fee posting in IFC.
    await page.reload();
    await expect(page.getByRole('button', { name: 'Buy BTC' })).toBeVisible();
    await tab(page, 'Trade history').click();
    await expect(page.locator(`tr[data-fill="${fills[0].id}"] td[class*=dk-num]`).last()).toContainText(/^0\.0\d+ IFC/);
  } finally {
    await publish(SCHEDULE, 'no fee token terms again');
  }
});

test(`${J} #10 a fee change is on the notice board before it takes effect, and an order placed before then keeps its fees`, async ({
  page,
}) => {
  // Three schedule versions (one a minute and a half ahead), a four-eyes notice, a fill and a desk.
  test.setTimeout(300_000);
  const who = account();
  const client = await api(who);
  const tag = Date.now().toString(36);

  await publish(changeTo('4'), 'IFC/USDT maker 0.04% before the change');
  let next = null;
  try {
    // An order the person places now, under the version in force: maker 0.04%. It rests until after the change.
    fund(who.email, 'USDT', '100');
    const order = await restingIfcBuy(client, '200', `js10-before-${tag}`);
    expect((await openOrders(who, 'IFC/USDT')).map((o) => o.id)).toContain(order.id);

    // Two operators approve the next version ahead of time, and the notice board says when it takes effect.
    const { ctx, sessions } = await ops();
    next = await setFeeSchedule(ctx, changeTo('2'), {
      effectiveAt: Date.now() + 90_000,
      reason: `LOCAL TEST ${J}: IFC/USDT maker 0.02% from a time a notice names`,
      sessions,
    });
    const effectiveAt = new Date(next.effectiveAt).toISOString();
    const draft = await draftNotice({
      kind: 'fee_change',
      title: `TEST fee change ${tag}`,
      body: 'TEST: the IFC/USDT maker fee goes from 0.04% to 0.02%.',
      startsAt: effectiveAt,
      key: `${J}:${tag}:fee-change`,
    });
    expect((await publishNotice(draft, `${J}:${tag}:fee-change`)).status).toBe('published');

    // The person reads it on the public board while the old version is still the one in force.
    await page.goto('/notice');
    const card = page.getByTestId(`notice-${draft.id}`);
    await expect(card).toContainText(`TEST fee change ${tag}`);
    await expect(card).toContainText('Fee change');
    const when = card.getByTestId('notice-effective');
    await expect(when).toHaveText(`Takes effect ${effectiveAt.slice(0, 19).replace('T', ' ')} UTC`);
    await expect(when).toHaveAttribute('datetime', effectiveAt);
    await expect(card).toContainText('Orders placed before then keep the fees in force when they were placed.');
    expect(Date.now()).toBeLessThan(Date.parse(effectiveAt));
    expect((await published()).body.version).not.toBe(`v${next.version}`);

    // The version takes effect at the time the notice named.
    await expect.poll(async () => (await published()).body.version, { timeout: 150_000 }).toBe(`v${next.version}`);
    expect(Date.now()).toBeGreaterThanOrEqual(Date.parse(effectiveAt));
    // Still resting: nothing filled it under the old version while the person waited.
    expect((await openOrders(who, 'IFC/USDT')).map((o) => o.id)).toContain(order.id);
    const { body: early } = await client.get(`/api/v1/account/trades?symbol=${encodeURIComponent('IFC/USDT')}&limit=100`);
    expect((Array.isArray(early) ? early : (early.trades ?? [])).filter((f) => f.order === order.id)).toEqual([]);

    // The order placed before then fills afterwards, and pays the maker rate of the version it was placed under (a
    // buyer's fee comes out of the IFC it receives).
    await sellInto(who, order, `${J}-10-${order.id}`);
    const fills = await fillsOf(client, 'IFC/USDT', order.id);
    for (const fill of fills) {
      expect(fill.takerOrMaker).toBe('maker');
      expect(fill.fee).toMatchObject({ currency: 'IFC', rate: '0.0004' });
    }

    // A new order is checked at the new rate.
    await openDesk(page, who, 'IFC/USDT');
    await page.mouse.move(0, 600);
    await tab(page, 'Limit').click();
    await page.getByRole('combobox', { name: 'Time in force' }).click();
    await page.getByRole('option', { name: 'Post only', exact: true }).click();
    await buyForm(page).getByRole('textbox', { name: 'Price' }).fill(order.price);
    const check = await checkOf(page, () => buyForm(page).getByRole('textbox', { name: 'Amount' }).fill(order.amount));
    expect(check).toMatchObject({ feeRole: 'maker', feeBps: 2 });
    await expect(feeLine(page)).toHaveText(`Fee ${pct(2)} · maker`);
  } finally {
    await publish(SCHEDULE, 'IFC/USDT back in the default pair group', next?.effectiveAt);
  }
});

test(`${J} #11 reads the fee and volume API: the same rates and volume as the screen`, async ({ page }) => {
  // A schedule version with the programme, a wait of up to three minutes for its snapshot, then none.
  test.setTimeout(360_000);
  const who = account();
  const client = await api(who);
  const feesOf = async (c) => {
    const { status, body } = await c.get('/api/v1/account/fees');
    expect(status, JSON.stringify(body).slice(0, 300)).toBe(200);
    return body;
  };
  const { version, snapshotAt } = await publishTiers(70_000, `TEST tier programme, VIP from ${VIP_FROM}, for the fee API`);
  try {
    // #6's market buy keeps this account over the TEST threshold, so the programme's own snapshot puts it on the TEST VIP
    // tier (#6's snapshot may already hold it there: a programme published again reads the last snapshot until the next).
    await expect
      .poll(async () => (await myTier(client)).lastSnapshot?.instant ?? null, {
        timeout: snapshotAt.getTime() - Date.now() + 90_000,
        intervals: [5_000],
      })
      .toBe(snapshotAt.toISOString());
    const tier = await myTier(client);
    expect(tier).toMatchObject({ tier: 'test-vip-1', lastSnapshot: { tierId: 'test-vip-1', scheduleVersion: version } });

    // The fee API answers the rates this account pays: the TEST VIP row, with no rank discount on a new TEST account.
    const mine = (await feesOf(client))['BTC/USDT'];
    expect(mine).toMatchObject({
      symbol: 'BTC/USDT',
      tier: 'test-vip-1',
      makerBps: 6,
      takerBps: 9,
      maker: '0.0006',
      taker: '0.0009',
      discountBps: 0,
      version,
    });
    // Another account is answered at its own tier, never this one's.
    const other = await api(otherTrader());
    const theirTier = (await myTier(other)).tier;
    expect((await feesOf(other))['BTC/USDT']).toMatchObject({ tier: theirTier });

    // The desk shows the same rates, and its order check prices a resting order at the same maker rate.
    await signIn(page, who);
    await page.goto(deskPath());
    await expect(page.getByRole('button', { name: 'Buy BTC' })).toBeVisible();
    await expect(buyForm(page).getByTestId('dk-fees-mine')).toHaveText(
      `Your rates: maker ${pct(mine.makerBps)} · taker ${pct(mine.takerBps)}`,
    );
    await page.mouse.move(0, 600);
    await tab(page, 'Limit').click();
    await page.getByRole('combobox', { name: 'Time in force' }).click();
    await page.getByRole('option', { name: 'Post only', exact: true }).click();
    await buyForm(page)
      .getByRole('textbox', { name: 'Price' })
      .fill(await awayBid(95));
    const check = await checkOf(page, () => buyForm(page).getByRole('textbox', { name: 'Amount' }).fill('0.001'));
    expect(check).toMatchObject({ feeRole: 'maker', feeBps: mine.makerBps, feeTier: mine.tier });

    // My tier shows the same volume the volume API counts, and the snapshot row the same figures.
    const now = await myTier(client);
    await page.goto('/fees/my-tier');
    await expect(page.locator('h2[data-tier=test-vip-1]')).toHaveText('Your tier: test-vip-1');
    await expect(page.locator(`[data-volume="${now.volume.amount}"]`)).toHaveText(
      `${now.volume.amount} counted toward the next snapshot so far, from ${now.volume.fills} trades`,
    );
    const row = page.locator(`tr[data-snapshot="${now.lastSnapshot.key}"]`);
    await expect(row.locator('td')).toHaveText([
      now.lastSnapshot.tierId,
      now.lastSnapshot.volume30d,
      String(now.lastSnapshot.countedFills),
      now.lastSnapshot.scheduleVersion,
    ]);
  } finally {
    await publish(SCHEDULE, 'tier programme off');
  }
  // With the programme off, the API is back to the regular rates.
  expect((await feesOf(client))['BTC/USDT']).toMatchObject({ tier: 'regular', makerBps: 8, takerBps: 10 });
});
