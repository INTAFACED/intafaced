import { test, expect } from '@playwright/test';
import { approverSessions, makeContext, setFeeSchedule } from '../../../../tooling/scripts/local-test-gates.mjs';
import { EDGE, api, journeyState } from './stack.mjs';
import { awayBid, fundedTrader, held, openDesk, openOrders } from './desk.mjs';

// J-cex-spot-10, in the running app (docs/roadmap/journeys.json): a person sees what they pay, what tier they are in,
// and how to get cheaper. One test per step, titled "J-cex-spot-10 #<n>", run in order on one TEST account funded with
// TEST USDT through the real ledger. The owner's schedule is written the way two operators would, through svc-trade's
// two-person door (`setFeeSchedule`), as TEST versions: the default pair group keeps the stack's own regular rates
// (maker 0.08%, taker 0.10%), so every other journey on the stack trades at the rates it always did. TEST groups hold
// markets no other journey trades: ETH/USDC at zero fee, and IFC/USDT, which #3 leaves blank for a moment. Steps 4-11
// join this file with the slices that build them.
const J = 'J-cex-spot-10';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

/** TEST rates through the real write path, not owner decisions. A TEST VIP tier lowers both rates. */
const REGULAR = { pairGroup: 'all-others', tierId: 'regular', zeroFee: false, makerBps: '8', takerBps: '10', minFee: null };
const VIP = { pairGroup: 'all-others', tierId: 'test-vip-1', zeroFee: false, makerBps: '6', takerBps: '9', minFee: null };
const ZERO = { pairGroup: 'test-zero-fee', tierId: 'regular', zeroFee: true, minFee: null };
const SCHEDULE = { defaultPairGroup: 'all-others', pairGroups: { 'ETH/USDC': 'test-zero-fee' }, rows: [REGULAR, VIP, ZERO] };
/** The same, with IFC/USDT in a pair group the owner named and gave no row: its rate is blank. */
const BLANK_IFC = { ...SCHEDULE, pairGroups: { ...SCHEDULE.pairGroups, 'IFC/USDT': 'test-unpriced' } };

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

/** Write `schedule` as the next version, effective in two seconds, and wait until the public read serves it. */
async function publish(schedule, reason) {
  const { ctx, sessions } = await ops();
  const row = await setFeeSchedule(ctx, schedule, { reason: `LOCAL TEST ${J}: ${reason}`, sessions });
  await expect.poll(async () => (await published()).body.version, { timeout: 20_000 }).toBe(`v${row.version}`);
  return row;
}

/** `bps` as the desk and the fee page write a rate: 8 → "0.08%". */
const pct = (bps) => `${Math.floor(bps / 100)}.${String(bps % 100).padStart(2, '0')}%`;

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
