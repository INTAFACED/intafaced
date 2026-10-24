import { test, expect } from '@playwright/test';
import { approverSessions, makeContext, setFeeSchedule } from '../../../../tooling/scripts/local-test-gates.mjs';
import { EDGE, api, bestPrices, fromUnits, fund, journeyState, otherTrader, times, toUnits } from './stack.mjs';
import { awayBid, deskPath, fundedTrader, held, openDesk, openOrders, signIn } from './desk.mjs';
import { draftNotice, publishNotice } from './notices.mjs';

// J-cex-spot-10, in the running app (docs/roadmap/journeys.json): a person sees what they pay, what tier they are in,
// and how to get cheaper. One test per step, titled "J-cex-spot-10 #<n>", run in order on one TEST account funded with
// TEST USDT through the real ledger. The owner's schedule is written the way two operators would, through svc-trade's
// two-person door (`setFeeSchedule`), as TEST versions: the default pair group keeps the stack's own regular rates
// (maker 0.08%, taker 0.10%), so every other journey on the stack trades at the rates it always did. TEST groups hold
// markets no other journey trades: ETH/USDC at zero fee, and IFC/USDT, which #3 leaves blank for a moment. #5-#6 add a
// TEST tier programme only for as long as they run. Steps 7, 9 and 11 join this file with the slices that build them.
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
 * cancels), and waits until nothing of `who`'s rests.
 */
async function sellInto(who, { id, price, amount }, clientOrderId) {
  if ((await openOrders(who, 'IFC/USDT')).some((o) => o.id === id)) {
    const { body } = await bestPrices('IFC/USDT');
    const ahead = body.bids.filter(([p]) => toUnits(p) >= toUnits(price)).reduce((sum, [, size]) => sum + toUnits(size), 0n);
    const size = fromUnits(ahead + toUnits(amount));
    const seller = otherTrader();
    fund(seller.email, 'IFC', size);
    const sell = await (
      await api(seller)
    ).post('/api/v1/orders', { symbol: 'IFC/USDT', side: 'sell', type: 'limit', amount: size, price, timeInForce: 'IOC', clientOrderId });
    expect(sell.status, JSON.stringify(sell.body).slice(0, 300)).toBeLessThan(300);
  }
  await expect.poll(async () => (await openOrders(who, 'IFC/USDT')).length, { timeout: 30_000 }).toBe(0);
}

/** A post-only IFC/USDT buy inside the spread, so it rests ahead of the house bids and a crossing sell reaches it first. */
async function restingIfcBuy(client, amount, clientOrderId) {
  const { bid, ask } = await bestPrices('IFC/USDT');
  const price = fromUnits(toUnits(bid) + ((toUnits(ask) - toUnits(bid)) / 2n / 10n ** 14n) * 10n ** 14n);
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
const buyForm = (page) => page.locator('form.dk-form[data-side=buy]');
const feeLine = (page) => buyForm(page).locator('.dk-fees > span').first();

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
    await expect(row.locator('.dk-rebate')).toContainText(/Rebate 0\.\d+ USDT/);
    await expect(row.locator('.dk-rebate')).toContainText(pct(5));
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
    'Not offered on spot: there is no fee token to pay fees in. The fee comes out of the BTC this order receives.',
  );
  // It stays reachable from the keyboard, and pressing or clicking it does nothing.
  await choice.focus();
  await expect(choice).toBeFocused();
  await page.keyboard.press('Enter');
  await choice.click({ force: true });
  await expect(page.locator('form.dk-form[data-side=sell] [data-fee-currency]')).toContainText('Fees in USDT');
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
  expect(JSON.stringify(sent.body)).toContain('trade.fee_currency_unsupported');
  expect(held(await client.balances(), 'USDT')).toBe(before);
  expect((await openOrders(who, 'BTC/USDT')).filter((o) => o.clientOrderId === clientOrderId)).toEqual([]);
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
