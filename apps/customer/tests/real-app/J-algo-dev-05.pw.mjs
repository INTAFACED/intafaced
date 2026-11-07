// World: none
import { test, expect } from './journey.mjs';
import { journeyState } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { closedBarsSince, tapeWindow } from './tape.mjs';

// J-algo-dev-05, in the running app (docs/roadmap/journeys.json): a strategy's orders obey order types, sizing and risk
// settings. One test per step, titled "J-algo-dev-05 #<n>", on one TEST developer who starts signed in with a strategy
// running as a backtest (the bar backtest room) or on paper (the sandbox's paper run). Written by an independent
// test-writer from the step's words (OWNER 212). Every figure is simulated; nothing here moves money.
//
// Steps whose slice is not built yet check their step's words with a short wait, so they fail fast and name what is
// missing. Their selectors (test ids, labels, the sandbox's order calls) are this file's proposal for UI that does not
// exist yet: a builder may rename one to match what it builds, never drop or loosen a check.
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

/** Saves a new signal-rules strategy on 1 minute bars of BTC/USDT at version 1. Every figure is a TEST simulation input. */
async function saveSignalStrategy(page, name, { stopLoss = '', takeProfit = '', size = '0.01' } = {}) {
  await page.goto('/quant/studio');
  const fresh = page.getByRole('button', { name: 'Start a new strategy' });
  if (await fresh.isVisible()) await fresh.click();
  await page.getByLabel('Strategy name').fill(name);
  await page.getByLabel('Simulated starting cash').fill('1000');
  await page.getByLabel('Block 1 symbol').fill('BTC/USDT');
  await page.getByLabel('Block 1 quantity').fill('0.01');
  await page.getByLabel('Max drawdown (service unit unspecified)').fill('100');
  await page.getByLabel('Max notional (service unit unspecified)').fill('500');
  await page.getByLabel('Kill threshold (service unit unspecified)').fill('50');
  await page.getByLabel('How the strategy trades').selectOption('signal');
  const builder = page.getByTestId('quant-signal-builder');
  await builder.getByLabel('Symbol').fill('BTC/USDT');
  await builder.getByLabel('Bar size').selectOption('1m');
  await builder.getByLabel('Fast average (bars)').fill('1');
  await builder.getByLabel('Slow average (bars)').fill('2');
  await builder.getByRole('combobox', { name: /^Size each entry by/ }).selectOption('quantity');
  await builder.getByLabel('Size', { exact: true }).fill(size);
  await builder.getByLabel('Stop loss (percent, optional)', { exact: true }).fill(stopLoss);
  await builder.getByLabel('Take profit (percent, optional)', { exact: true }).fill(takeProfit);
  await page.getByRole('button', { name: 'Save to library', exact: true }).click();
  await expect(page.getByTestId('quant-save-state')).toHaveText('Saved as version 1.');
}

/** Runs a saved strategy in the bar backtest room on a window of the TEST tape, with no slippage and no delay. */
async function backtest(page, strategy, window) {
  await page.goto('/quant/backtest');
  const room = page.getByTestId('quant-bar-backtest');
  await room.getByRole('combobox', { name: /^Strategy/ }).selectOption({ label: strategy });
  await room.getByLabel('From (UTC)').fill(window.from);
  await room.getByLabel('To (UTC)').fill(window.to);
  await room.getByRole('combobox', { name: /^Fill a signal at/ }).selectOption('next_open');
  await room.getByRole('combobox', { name: /^Fee rate/ }).selectOption('taker');
  await room.getByLabel('Delay (bars)').fill('0');
  await room.getByLabel('Slippage (basis points)').fill('0');
  await room.getByTestId('quant-backtest-run').click();
  await expect(room.getByTestId('quant-bar-result')).toBeVisible();
  return room;
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

/** Opens the risk screen of a saved strategy from the strategies list. */
async function riskScreen(page, strategy) {
  await page.goto('/quant/strategies');
  await page.getByTestId('quant-strategy-name').filter({ hasText: strategy }).click();
  const screen = page.getByTestId('quant-risk-screen');
  await expect(screen, 'the strategy has no risk screen yet (AL-risk-01)').toBeVisible(UNBUILT);
  return screen;
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

test(`${J} #3 attaches a take profit and a stop loss and runs a bar that hits both: the stop fills first and the result says the pessimistic rule applied`, async ({
  page,
}) => {
  test.setTimeout(15 * 60_000);
  await developer(page);
  // A stop loss and a take profit a thousandth of a percent either side of the entry: a TEST bar that moves at all
  // both ways from its open reaches both.
  const STOP = '0.001';
  const TARGET = '0.001';
  await saveSignalStrategy(page, 'TEST both exits', { stopLoss: STOP, takeProfit: TARGET });
  const window = await tapeWindow(60);
  const room = await backtest(page, 'TEST both exits', window);

  // Each stop-loss exit is paired with the entry before it; on the bar it filled, the tape reached the take profit too.
  const bars = new Map((await closedBarsSince(window.from)).map(([at, open, high, low]) => [at, { open, high, low }]));
  const rows = await room
    .getByTestId('quant-bar-trade')
    .evaluateAll((els) =>
      els.map((el) => ({ ts: el.dataset.ts, side: el.dataset.side, cells: [...el.querySelectorAll('td')].map((td) => td.textContent) })),
    );
  const both = [];
  for (let i = 1; i < rows.length; i++) {
    const [entry, exit] = [rows[i - 1], rows[i]];
    if (entry.side !== 'buy' || exit.side !== 'sell' || exit.cells[2] !== 'Stop loss') continue;
    const bar = bars.get(Date.parse(exit.ts));
    if (!bar) continue;
    const entered = Number(entry.cells[5]);
    const target = entered * (1 + Number(TARGET) / 100);
    const stop = entered * (1 - Number(STOP) / 100);
    if (bar.high >= target && bar.low <= stop) both.push({ exit, stop, bar });
  }
  expect(both.length, 'no bar in the window reached both the stop loss and the take profit of an open position').toBeGreaterThan(0);

  // The stop filled first: the exit on that bar is the stop loss, at the stop (or the open, had the bar gapped past
  // it), and no take-profit exit shares its bar.
  for (const { exit, stop, bar } of both) {
    const price = Number(exit.cells[5]);
    expect(price).toBeCloseTo(bar.open <= stop ? bar.open : stop, 6);
    expect(rows.filter((r) => r.ts === exit.ts && r.cells[2] === 'Take profit')).toHaveLength(0);
  }
  // The result says the pessimistic rule applied.
  await expect(room.getByTestId('quant-bar-assumptions').locator('[data-assumption="stop_loss_first"]')).toHaveText(
    'A bar reached both the stop loss and the take profit; the stop loss was taken first.',
  );
});

test(`${J} #4 sets pyramiding to two and adds a third entry: rejected with "limit hit"; a blank sizing rule refuses naming it`, async ({
  page,
}) => {
  await developer(page);
  await paperRun(
    page,
    `oms.setPyramiding(2);
oms.buy("BTC-USD", "0.01");
oms.buy("BTC-USD", "0.01");
const third = oms.buy("BTC-USD", "0.01");
console.log(third.status);
console.log(third.reason);`,
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

test(`${J} #7 leaves the risk screen's deposit-percentage cap blank and tries the trading switch: a refusal naming the cap and the switch stays off; off by default and off again after any version change`, async ({
  page,
}) => {
  await developer(page);
  const STRATEGY = 'TEST risk caps';
  await saveSignalStrategy(page, STRATEGY);
  const screen = await riskScreen(page, STRATEGY);
  const trading = screen.getByRole('switch', { name: 'Trading' });

  // Off by default, on a strategy nobody has touched.
  await expect(trading).toHaveAttribute('aria-checked', 'false');
  // Every cap but the deposit percentage set; that one left blank.
  const deposit = screen.getByLabel('Deposit-percentage cap');
  await expect(deposit).toHaveValue('');
  const caps = screen.getByTestId('quant-risk-cap');
  for (let i = 0; i < (await caps.count()); i++) {
    const cap = caps.nth(i).getByRole('textbox');
    if ((await cap.getAttribute('data-cap')) !== 'depositPercent') await cap.fill('10');
  }
  await screen.getByRole('button', { name: 'Save caps' }).click();
  await trading.click();
  await expect(screen.getByTestId('quant-risk-refusal')).toContainText('Deposit-percentage cap');
  await expect(trading).toHaveAttribute('aria-checked', 'false');
  await page.reload();
  await expect(page.getByTestId('quant-risk-screen').getByRole('switch', { name: 'Trading' })).toHaveAttribute('aria-checked', 'false');

  // With the cap set the switch turns on; a new version of the strategy turns it off again.
  await page.getByTestId('quant-risk-screen').getByLabel('Deposit-percentage cap').fill('10');
  await page.getByTestId('quant-risk-screen').getByRole('button', { name: 'Save caps' }).click();
  await page.getByTestId('quant-risk-screen').getByRole('switch', { name: 'Trading' }).click();
  await expect(page.getByTestId('quant-risk-screen').getByRole('switch', { name: 'Trading' })).toHaveAttribute('aria-checked', 'true');
  await page.goto('/quant/strategies');
  await page.getByTestId('quant-strategy-name').filter({ hasText: STRATEGY }).click();
  await page.getByRole('link', { name: 'Open in Studio' }).click();
  await page.getByTestId('quant-signal-builder').getByLabel('Slow average (bars)').fill('3');
  await page.getByRole('button', { name: 'Save to library', exact: true }).click();
  await expect(page.getByTestId('quant-save-state')).toHaveText('Saved as version 2.');
  const after = await riskScreen(page, STRATEGY);
  await expect(after.getByRole('switch', { name: 'Trading' })).toHaveAttribute('aria-checked', 'false');
});

test(`${J} #8 lets equity fall below the equity-stop floor: the strategy turns reduce-only and the event is recorded; with the close-out policy a close-out order is placed once`, async ({
  page,
}) => {
  test.setTimeout(15 * 60_000);
  await developer(page);
  const window = await tapeWindow(60);

  // A floor a cent under the 1000 starting cash: the first entry's fee alone takes equity below it.
  async function floored(name, policy) {
    await saveSignalStrategy(page, name);
    const screen = await riskScreen(page, name);
    await screen.getByLabel('Equity-stop floor').fill('999.99');
    await screen.getByRole('combobox', { name: 'When the floor is hit' }).selectOption(policy);
    await screen.getByRole('button', { name: 'Save caps' }).click();
    return backtest(page, name, window);
  }

  // Reduce-only: the event is recorded once, at the first bar below the floor, and no entry fills after it.
  let room = await floored('TEST floor reduce', 'reduce_only');
  const event = room.getByTestId('quant-risk-event').and(page.locator('[data-kind="equity_stop"]'));
  await expect(event).toHaveCount(1);
  await expect(event).toHaveAttribute('data-mode', 'reduce_only');
  expect(Number(await event.getAttribute('data-equity'))).toBeLessThan(999.99);
  const at = await event.getAttribute('data-ts');
  const buysAfter = await room
    .getByTestId('quant-bar-trade')
    .evaluateAll((els, ts) => els.filter((el) => el.dataset.side === 'buy' && el.dataset.ts > ts).length, at);
  expect(buysAfter).toBe(0);
  await expect(room.getByTestId('quant-bar-trade').filter({ hasText: 'Close-out' })).toHaveCount(0);

  // With the close-out policy: the same event, and exactly one close-out order, however many bars stay below.
  room = await floored('TEST floor close', 'close_out');
  await expect(room.getByTestId('quant-risk-event').and(page.locator('[data-kind="equity_stop"]'))).toHaveCount(1);
  await expect(room.getByTestId('quant-bar-trade').filter({ hasText: 'Close-out' })).toHaveCount(1);
  await expect(room.getByTestId('quant-bar-total-openQty')).toHaveAttribute('data-value', '0');
});
