// World: none
import { test, expect } from './journey.mjs';
import { journeyState } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';

// J-algo-dev-05, in the running app (docs/roadmap/journeys.json): a strategy's orders obey order types, sizing and risk
// settings. One test per step, titled "J-algo-dev-05 #<n>", on one TEST developer who starts signed in with a strategy
// running as a backtest (the bar backtest room) or on paper (the sandbox's paper run). Written by an independent
// test-writer from the step's words (OWNER 212). Every figure is simulated; nothing here moves money.
//
// Steps whose slice is not built yet check their step's words with a short wait, so they fail fast and name what is
// missing. Their selectors (test ids, labels, the sandbox's order calls) are this file's proposal for UI that does not
// exist yet: a builder may rename one to match what it builds, never drop or loosen a check.
// This file carries #1 #2 #4 #5 #6, which the paper book builds. #3 (the bar backtest's both-exits bar), #7 (the risk
// screen) and #8 (the equity-stop floor) are written (the tests: draft #7419) and land with the code that builds them:
// the merge seal reads main's list of steps not built yet, so a failing step can't arrive ahead of its code here.
const J = 'J-algo-dev-05';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const UNBUILT = { timeout: 5_000 };

test.describe.configure({ mode: 'default' });

/** Signs the journey's TEST developer in, making and verifying them on the first step that runs. */
async function developer(page) {
  let who = run.read().account;
  if (!who) {
    who = await signUp(page, 'jo');
    await verify(page, who);
    run.reset({ account: who });
  }
  await signIn(page, who);
  return who;
}

/** Runs a strategy's source as a paper run in the sandbox (TEST simulated cash) and returns the page once its result shows. */
async function paperRun(page, source, cash = '1000') {
  await page.goto('/quant/sandbox');
  await page.getByLabel('Simulated starting cash').fill(cash);
  await page.getByLabel('Strategy source').fill(source);
  await page.getByRole('button', { name: 'Review simulation' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Run simulation' }).click();
  await expect(page.getByText('Paper — not live performance', { exact: true })).toBeVisible();
}

/** The order events a paper run recorded, in order, as `kind` (and the order they belong to). */
function orderEvents(page) {
  return page.getByTestId('quant-order-events').getByTestId('quant-order-event');
}

async function eventKinds(page, order) {
  const rows = orderEvents(page).and(page.locator(`[data-order="${order}"]`));
  return rows.evaluateAll((els) => els.map((el) => el.getAttribute('data-kind')));
}

const MARK = '50000'; // the paper book's TEST mark for BTC-USD
const BELOW = '49990'; // a limit buy below it

test(`${J} #1 places a limit buy below the market from the strategy: events new, accepted, filled when the price reaches it; a quantity of zero is rejected with "quantity invalid" and the strategy sees a rejected event`, async ({
  page,
}) => {
  await developer(page);
  await paperRun(
    page,
    `const a = oms.limitBuy("BTC-USD", "0.01", "${BELOW}", "gtc");
const z = oms.limitBuy("BTC-USD", "0", "${BELOW}", "gtc");
console.log(z.status);
console.log(z.reason);`,
  );
  const events = orderEvents(page);
  await expect(events.first(), 'a paper run records no order events yet (AL-orders-01)').toBeVisible(UNBUILT);

  // The limit buy: placed below the market, it is new, then accepted, and fills only once the price reaches its limit.
  const first = events.and(page.locator('[data-type="limit"][data-side="buy"]')).first();
  const order = await first.getAttribute('data-order');
  expect(await eventKinds(page, order)).toEqual(['new', 'accepted', 'filled']);
  const placed = orderEvents(page).and(page.locator(`[data-order="${order}"][data-kind="new"]`));
  expect(Number(await placed.getAttribute('data-limit'))).toBe(Number(BELOW));
  expect(Number(await placed.getAttribute('data-market'))).toBe(Number(MARK));
  expect(Number(BELOW)).toBeLessThan(Number(MARK));
  const filled = orderEvents(page).and(page.locator(`[data-order="${order}"][data-kind="filled"]`));
  expect(Number(await filled.getAttribute('data-price'))).toBeLessThanOrEqual(Number(BELOW));
  expect(Number(await filled.getAttribute('data-market'))).toBeLessThanOrEqual(Number(BELOW));

  // Quantity zero: rejected with its reason, and the strategy itself saw the rejected event (its own log printed it).
  const zero = events.and(page.locator('[data-qty="0"]'));
  await expect(zero).toHaveCount(1);
  const zeroOrder = await zero.getAttribute('data-order');
  expect(await eventKinds(page, zeroOrder)).toEqual(['rejected']);
  await expect(zero).toHaveAttribute('data-reason', 'quantity invalid');
  await expect(zero).toContainText('quantity invalid');
  await expect(page.getByTestId('more-body')).toHaveText('rejected\nquantity invalid');
});

test(`${J} #2 cancels an order before it fills: cancel pending then cancelled, and no fill`, async ({ page }) => {
  await developer(page);
  // A limit far below the market cannot fill before the strategy cancels it.
  await paperRun(
    page,
    `const a = oms.limitBuy("BTC-USD", "0.01", "40000", "gtc");
oms.cancel(a.id);`,
  );
  const events = orderEvents(page);
  await expect(events.first(), 'a paper run records no order events yet (AL-orders-01)').toBeVisible(UNBUILT);
  const order = await events.first().getAttribute('data-order');
  expect(await eventKinds(page, order)).toEqual(['new', 'accepted', 'cancel_pending', 'cancelled']);
  await expect(events.and(page.locator('[data-kind="filled"]'))).toHaveCount(0);
  await expect(page.getByRole('table', { name: 'Simulated fills' }).getByRole('row')).toHaveCount(1); // the header only
});

test(`${J} #4 sets pyramiding to two and adds a third entry: rejected with "limit hit"; a blank sizing rule refuses naming it`, async ({
  page,
}) => {
  await developer(page);
  // 10000 of TEST cash: two entries of 500 plus their fee fit, so the third is refused for pyramiding, not for cash
  // (with 1000, the second entry's fee alone would take it past the cash, #6).
  await paperRun(
    page,
    `oms.setPyramiding(2);
oms.buy("BTC-USD", "0.01");
oms.buy("BTC-USD", "0.01");
const third = oms.buy("BTC-USD", "0.01");
console.log(third.status);
console.log(third.reason);`,
    '10000',
  );
  const events = orderEvents(page);
  await expect(events.first(), 'a paper run has no pyramiding setting or order events yet (AL-orders-02)').toBeVisible(UNBUILT);
  // Two entries fill; the third is rejected with "limit hit" and adds nothing.
  await expect(events.and(page.locator('[data-kind="filled"][data-side="buy"]'))).toHaveCount(2);
  const rejected = events.and(page.locator('[data-kind="rejected"]'));
  await expect(rejected).toHaveCount(1);
  await expect(rejected).toHaveAttribute('data-reason', 'limit hit');
  await expect(page.getByTestId('more-body')).toHaveText('rejected\nlimit hit');
  await expect(page.getByRole('table', { name: 'Simulated positions' }).getByRole('row', { name: /BTC-USD/ })).toContainText('0.02');

  // A blank sizing rule: the strategy cannot be saved, and the refusal names the sizing rule.
  await page.goto('/quant/studio');
  const fresh = page.getByRole('button', { name: 'Start a new strategy' });
  if (await fresh.isVisible()) await fresh.click();
  await page.getByLabel('How the strategy trades').selectOption('signal');
  const builder = page.getByTestId('quant-signal-builder');
  await builder.getByLabel('Pyramiding (entries at most)').fill('2', UNBUILT);
  await builder.getByLabel('Size', { exact: true }).fill('');
  await page.getByRole('button', { name: 'Save to library', exact: true }).click();
  await expect(page.getByTestId('quant-save-state')).toContainText('Size');
  await expect(page.getByTestId('quant-save-state')).not.toHaveText(/^Saved as version/);
});

test(`${J} #5 reverses from long three to short two: two legs, each checked; the open leg is refused when no short rule exists`, async ({
  page,
}) => {
  await developer(page);
  await paperRun(
    page,
    `oms.buy("BTC-USD", "3");
const r = oms.reverse("BTC-USD", "-2");
console.log(r.legs.length);`,
    '1000000',
  );
  const events = orderEvents(page);
  await expect(events.first(), 'a paper run has no reverse or order events yet (AL-orders-02)').toBeVisible(UNBUILT);
  // The reversal is two legs: close the long three, then open the short two; each leg has its own check.
  const legs = page.getByTestId('quant-reverse-leg');
  await expect(legs).toHaveCount(2);
  await expect(legs.nth(0)).toHaveAttribute('data-leg', 'close');
  await expect(legs.nth(0)).toHaveAttribute('data-qty', '3');
  await expect(legs.nth(1)).toHaveAttribute('data-leg', 'open');
  await expect(legs.nth(1)).toHaveAttribute('data-qty', '2');
  for (const leg of [legs.nth(0), legs.nth(1)]) await expect(leg).toHaveAttribute('data-checked', 'true');
  // On spot paper there is no published short rule: the close leg fills, the open leg is refused naming it, and the
  // position is flat, not short.
  await expect(legs.nth(0)).toHaveAttribute('data-outcome', 'filled');
  await expect(legs.nth(1)).toHaveAttribute('data-outcome', 'refused');
  await expect(legs.nth(1)).toContainText('short rule');
  await expect(page.getByTestId('more-body')).toHaveText('2');
  await expect(page.getByRole('table', { name: 'Simulated positions' }).getByRole('row', { name: /BTC-USD/ })).toHaveCount(0);
});

test(`${J} #6 sends a buy whose notional plus fee is more than the cash: rejected with the numbers and the cash unchanged; two pending sells that together exceed the position reject the second`, async ({
  page,
}) => {
  await developer(page);
  // 0.01 BTC at the 50000 mark is 500 before its fee, against 100 of TEST cash.
  await paperRun(page, `const b = oms.buy("BTC-USD", "0.01");`, '100');
  const events = orderEvents(page);
  await expect(events.first(), 'a paper run has no pre-trade check or order events yet (AL-orders-03)').toBeVisible(UNBUILT);
  const rejected = events.and(page.locator('[data-kind="rejected"]'));
  await expect(rejected).toHaveCount(1);
  await expect(rejected).toHaveAttribute('data-notional', '500');
  const fee = Number(await rejected.getAttribute('data-fee'));
  expect(fee).toBeGreaterThan(0);
  await expect(rejected).toHaveAttribute('data-cash', '100');
  for (const number of ['500', String(fee), '100']) await expect(rejected).toContainText(number);
  await expect(page.getByRole('table', { name: 'Simulated fills' }).getByRole('row')).toHaveCount(1); // the header only
  await expect(page.getByTestId('quant-paper-cash')).toHaveAttribute('data-value', '100');

  // A position of 0.01, then two resting sells of 0.006 each: together 0.012, more than the position, so the second
  // is rejected and the first rests.
  await paperRun(
    page,
    `oms.buy("BTC-USD", "0.01");
const s1 = oms.limitSell("BTC-USD", "0.006", "60000", "gtc");
const s2 = oms.limitSell("BTC-USD", "0.006", "60000", "gtc");
console.log(s1.status);
console.log(s2.status);`,
  );
  const sells = orderEvents(page).and(page.locator('[data-side="sell"]'));
  const firstSell = await sells.first().getAttribute('data-order');
  expect(await eventKinds(page, firstSell)).toEqual(['new', 'accepted']);
  const second = sells.and(page.locator('[data-kind="rejected"]'));
  await expect(second).toHaveCount(1);
  expect(await second.getAttribute('data-order')).not.toBe(firstSell);
  await expect(page.getByTestId('more-body')).toHaveText('accepted\nrejected');
});
