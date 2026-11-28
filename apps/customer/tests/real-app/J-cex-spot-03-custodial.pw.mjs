// World: book, market, stack
import { test, expect } from './journey.mjs';
import { ORIGIN, api, bestPrices, fromUnits, fund, journeyState, toUnits, tool } from './stack.mjs';
import {
  awayBid as engineAwayBid,
  confirm,
  fundedTrader,
  held,
  openDesk,
  openOrders as engineOpenOrders,
  placements,
  previewed,
  reviewSheet,
} from './desk.mjs';
import { localMinuteField, minuteStart } from './clock.mjs';

// J-cex-spot-03's custodial checks, on our own engine (BTC/USDT, TEST USDT on our ledger): its fill-or-kill and
// good-till-date. They need our own book and a ledger-funded trader, so they are custody-on checks by design and this
// part file keeps today's custody switch (launch-custody.mjs, a `-custodial` part file), while J-cex-spot-03.pw.mjs runs
// the steps custody off, as launch does. Neither test is a step: the steps are proved on the person's own venue account,
// where fill-or-kill is listed as not offered and good-till-date is run by INTAFACED. Every figure is TEST.
const J = 'J-cex-spot-03';
const run = journeyState(`${J}-custodial-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const buyForm = (page) => page.locator('form[data-testid="dk-form"][data-side="buy"]');

const ENGINE_FUNDED = '60000';
const engineTab = (page, name) => page.locator('[role=tab]', { hasText: new RegExp(`^${name}$`) });
async function enginePickTif(page, label) {
  await page.getByRole('combobox', { name: /Time in force/i }).click();
  await page.getByRole('option', { name: label, exact: true }).click();
}
/** A limit buy on our engine's desk with the picked time in force, reviewed and confirmed. Returns the order body sent. */
async function engineLimitBuy(page, { tif, price, amount }) {
  const sent = placements(page);
  await engineTab(page, 'Limit').click();
  await enginePickTif(page, tif);
  await buyForm(page).getByRole('textbox', { name: /Price/i }).fill(price);
  await previewed(page, () =>
    buyForm(page)
      .getByRole('textbox', { name: /Amount/i })
      .fill(amount),
  );
  await buyForm(page)
    .getByRole('button', { name: /Buy BTC/i })
    .click();
  await expect(reviewSheet(page)).toContainText(tif);
  await confirm(page, 'buy');
  await expect.poll(() => sent.length).toBe(1);
  return sent[0];
}
/** The TEST USDT trader on our engine, in its own browser context: made once in this run, then signed in again. */
async function engineDesk(browser) {
  const context = await browser.newContext({ baseURL: ORIGIN });
  const page = await context.newPage();
  let who = run.read().engine;
  if (!who) {
    who = await fundedTrader(page, 'js3e', ENGINE_FUNDED);
    run.write({ engine: who });
  }
  await openDesk(page, who);
  return { page, who, context };
}

test.describe.configure({ mode: 'default' });

test(`${J}, the custodial Later branch, checked on our own engine: a fill-or-kill buy bigger than the book fills nothing, the resting sells stay level for level and nothing stays held`, async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const { page: enginePage, who, context } = await engineDesk(browser);
  const { ask, body } = await bestPrices();
  // Every sell at or under the best ask's price, plus every sell the depth read returns (the TEST ladder is a few levels
  // a side), and one lot more. The TEST market maker places its new ladder before it cancels the old one, so for a
  // moment both rest and the new one can put a whole ladder at or under this ask; even then the book cannot fill this.
  const atAsk = body.asks.filter(([p]) => toUnits(p) <= toUnits(ask)).reduce((sum, [, size]) => sum + toUnits(size), 0n);
  const allAsks = body.asks.reduce((sum, [, size]) => sum + toUnits(size), 0n);
  const amount = fromUnits(atAsk + allAsks + toUnits('0.001'));
  // The hold must fit, or the order is refused for funds and never reaches the fill-or-kill rule this step is about.
  const cost = (toUnits(ask) * toUnits(amount)) / toUnits('1');
  const freeUsdt = toUnits((await (await api(who)).balances()).USDT.free);
  if (cost > freeUsdt) fund(who.email, 'USDT', fromUnits(((cost - freeUsdt) / toUnits('1')) * toUnits('1') + toUnits('100')));
  const before = await (await api(who)).balances();
  await openDesk(enginePage, who);
  // The TEST maker's quotes held where they rest (local-test-market.mjs hold), so the resting sells can be compared level
  // for level after the order; released however the step ends.
  tool('local-test-market.mjs', 'hold', 'BTC/USDT');
  let asksBefore;
  let asksAfter;
  let sent;
  try {
    asksBefore = (await bestPrices()).body.asks;
    sent = await engineLimitBuy(enginePage, { tif: 'Fill or kill', price: ask, amount });
    await expect(buyForm(enginePage)).toContainText('Fill-or-kill order not placed');
    asksAfter = (await bestPrices()).body.asks;
  } finally {
    tool('local-test-market.mjs', 'release', 'BTC/USDT');
  }
  expect(asksAfter, 'the resting sells stay, level for level').toEqual(asksBefore);
  expect(sent).toMatchObject({ type: 'limit', timeInForce: 'FOK', postOnly: false });
  await expect(buyForm(enginePage)).toContainText('Fill-or-kill order not placed');
  await expect(buyForm(enginePage)).toContainText('nothing was traded');
  const after = await (await api(who)).balances();
  expect(after.USDT.total).toBe(before.USDT.total);
  expect(after.BTC?.total).toBe(before.BTC?.total);
  expect(held(after, 'USDT')).toBe(0n);
  expect((await bestPrices()).body.asks.length).toBeGreaterThan(0);
  await context.close();
});

test(`${J}, the custodial Later branch, checked on our own engine: a good-till-date buy refuses a past time, shows its expiry in the review, and at the expiry leaves the book as expired with its hold released once`, async ({
  browser,
}) => {
  test.setTimeout(480_000);
  const { page: enginePage, who, context } = await engineDesk(browser);
  const sent = placements(enginePage);
  await engineTab(enginePage, 'Limit').click();
  await enginePickTif(enginePage, 'Good till date');
  const price = await engineAwayBid(90);
  await buyForm(enginePage).getByRole('textbox', { name: 'Price' }).fill(price);
  await buyForm(enginePage).getByRole('textbox', { name: 'Amount' }).fill('0.001');
  const expires = enginePage.getByLabel('Expires');
  await expires.fill(localMinuteField(Date.now() - 3600_000));
  await expect(enginePage.getByText('Pick a time in the future.')).toBeVisible();
  await expect(buyForm(enginePage).getByRole('button', { name: 'Buy BTC' })).toBeDisabled();

  // A whole minute at least 60 seconds away: the field is to the minute.
  const at = minuteStart(Date.now() + 120_000);
  await previewed(enginePage, () => expires.fill(localMinuteField(at)));
  await buyForm(enginePage).getByRole('button', { name: 'Buy BTC' }).click();
  const review = reviewSheet(enginePage);
  await expect(review).toContainText('Good till date');
  // The review's Expires row is the time that was picked, as this browser writes it.
  const picked = await enginePage.evaluate((ms) => new Date(ms).toLocaleString(), at);
  await expect(review.locator('dl > div', { has: enginePage.locator('dt', { hasText: /^Expires$/ }) }).locator('dd')).toHaveText(picked);
  await confirm(enginePage, 'buy');
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ timeInForce: 'GTD', expireAt: new Date(at).toISOString() });
  const orders = await engineOpenOrders(who);
  expect(orders).toHaveLength(1);
  expect(held(await (await api(who)).balances(), 'USDT')).toBe((toUnits(price) * toUnits('0.001')) / toUnits('1'));

  // At the expiry the order leaves the book on its own and the hold is released, once.
  await expect.poll(async () => (await engineOpenOrders(who)).length, { timeout: 150_000, intervals: [2000] }).toBe(0);
  expect(Date.now()).toBeGreaterThanOrEqual(at);
  await expect.poll(async () => held(await (await api(who)).balances(), 'USDT'), { timeout: 20_000 }).toBe(0n);
  const { status, body } = await (await api(who)).get(`/api/v1/orders/${orders[0].id}?symbol=BTC%2FUSDT`);
  expect(status).toBe(200);
  expect(body.status).toBe('expired');
  await enginePage.reload();
  await engineTab(enginePage, 'Order history').click();
  await expect(enginePage.getByTestId('dk-bottom-body').locator('table tbody tr').first()).toContainText(/Expired/i);
  await context.close();
});
