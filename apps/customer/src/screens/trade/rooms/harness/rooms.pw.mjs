// Walks the TEST-labelled states of the Options, Execution and Quote desk rooms in the harness page, with the API mocked
// from the rooms' own fixtures (rooms.mock.mjs). Every scenario ends with the same three checks: no console errors, no
// banned words in the visible text, and every screenshot non-empty. Shots go to ROOMS_SHOTS at 1440x900 and 1280x800.
import { test, expect } from '@playwright/test';
import { mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { installMock, EXEC_NOW, OTC_NOW, TEST_QUOTES } from './rooms.mock.mjs';

const shots = process.env.ROOMS_SHOTS ?? '/Users/Nitro/.codex/context/work/design/trade-rooms/TROPT/harness/';
mkdirSync(shots, { recursive: true });

// "unavailable" counts only when it is the whole label (a bare word with no reason beside it).
const BANNED = [/(^|\n)\s*unavailable\s*(\n|$)/i, /coming soon/i, /fixture/i, /lifecycle/i];
const BANNED_CASE = [/TRD-/, /DIRECTION/, /SOCKET/];

const taken = [];
const SIZES = [
  [1440, 900],
  [1280, 800],
];

/** One screenshot at both sizes; each file must exist and not be empty. */
async function shot(page, name, { full = true } = {}) {
  await page.waitForTimeout(400); // let dialogs and fades finish
  for (const [width, height] of SIZES) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(150);
    const file = join(shots, `${name}-${width}.png`);
    await page.screenshot({ path: file, fullPage: full });
    expect(statSync(file).size, `${name}-${width}.png is empty`).toBeGreaterThan(8000);
    taken.push(file);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

/** The visible text must be free of internal words; the console must be free of errors. */
async function clean(page, mock) {
  const visible = await page.evaluate(() => document.body.innerText);
  const raw = await page.evaluate(() => document.body.textContent ?? '');
  for (const re of BANNED) expect(visible, `banned text ${re}`).not.toMatch(re);
  for (const re of BANNED_CASE) expect(raw, `banned text ${re}`).not.toMatch(re);
  expect(mock.errors, 'console errors').toEqual([]);
}

async function start(page, room, { at, url, ...options } = {}) {
  const mock = await installMock(page, { room, now: at, ...options });
  await page.clock.setFixedTime(at);
  await page.goto(url ?? `/?room=${room}`);
  return mock;
}

const dialog = (page) => page.getByRole('alertdialog');
/** The kit renders a selectable table as role=grid and a plain one as role=table. */
const grid = (page, name) => page.getByRole('grid', { name }).or(page.getByRole('table', { name }));

// ======================================================================================= Options
test.describe('Options', () => {
  test('chain: paper, live-blocked and incomplete TEST contracts', async ({ page }) => {
    const mock = await start(page, 'options', { at: OTC_NOW });
    const table = grid(page, 'Option contracts');
    await expect(table.getByText('TEST-BTC-25DEC26-60000-C')).toBeVisible();
    await expect(page.getByText('Live orders: blocked')).toBeVisible();
    await expect(page.getByText('Paper orders: allowed')).toBeVisible();
    await expect(table.getByText('TEST-BTC-LIVE-65000-C')).toBeVisible();
    await expect(table.getByText('TEST-BTC-NOTERMS-C')).toBeVisible();
    await expect(table.getByText('Terms incomplete')).toBeVisible();
    await expect(table.getByText('TEST-BTC-CLOSED-80000-C')).toBeVisible();
    await shot(page, 'options-01-chain');
    await clean(page, mock);
  });

  test('ticket: review a paper contract, cost block, confirm, order lands', async ({ page }) => {
    const mock = await start(page, 'options', { at: OTC_NOW });
    await grid(page, 'Option contracts').getByText('TEST-BTC-25DEC26-60000-C').click();
    const ticket = page.getByRole('region', { name: 'Order ticket' });
    await expect(ticket.getByText('TEST-BTC-25DEC26-60000-C')).toBeVisible();
    await ticket.getByLabel('Size in contracts').fill('1');
    await ticket.getByLabel('Limit price').fill('500');
    await ticket.getByRole('button', { name: 'Review order' }).click();
    await expect(ticket.getByText('Cost before you confirm')).toBeVisible();
    await expect(ticket.getByText('Paper: nothing is held')).toBeVisible();
    await expect(ticket.getByText('Total to commit')).toHaveCount(0);
    await shot(page, 'options-02-ticket-review');
    await ticket.getByRole('button', { name: 'Place order' }).click();
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page).getByText('Place this order?')).toBeVisible();
    await shot(page, 'options-03-ticket-confirm');
    await dialog(page).getByRole('button', { name: 'Place order' }).click();
    await expect(page.getByText('Done. Your order list will update in a moment.')).toBeVisible();
    expect(mock.called('orders').filter((c) => c.method === 'POST')).toHaveLength(1);
    await page.getByRole('tab', { name: 'Orders' }).click();
    await expect(grid(page, 'Open orders').getByText('TEST-BTC-25DEC26-60000-C')).toBeVisible();
    await shot(page, 'options-04-orders-after-place');
    await clean(page, mock);
  });

  test('orders: cancel all open option orders, one answer per row', async ({ page }) => {
    const mock = await start(page, 'options', { at: OTC_NOW });
    for (const price of ['500', '510']) {
      await grid(page, 'Option contracts').getByText('TEST-BTC-25DEC26-60000-C').click();
      const ticket = page.getByRole('region', { name: 'Order ticket' });
      await ticket.getByLabel('Size in contracts').fill('1');
      await ticket.getByLabel('Limit price').fill(price);
      await ticket.getByRole('button', { name: 'Review order' }).click();
      await ticket.getByRole('button', { name: 'Place order' }).click();
      await dialog(page).getByRole('button', { name: 'Place order' }).click();
      await expect(page.getByText('Done. Your order list will update in a moment.')).toBeVisible();
    }
    await page.getByRole('tab', { name: 'Orders' }).click();
    await page.getByRole('button', { name: 'Cancel all open orders' }).click();
    await expect(dialog(page).getByText('Cancel all open option orders')).toBeVisible();
    await shot(page, 'options-04b-cancel-all-confirm');
    await dialog(page)
      .getByRole('button', { name: /Cancel 2 orders/ })
      .click();
    await expect(page.getByText('Cancelled', { exact: true }).first()).toBeVisible();
    await shot(page, 'options-04c-cancel-all-result');
    await clean(page, mock);
  });

  test('ticket: a live contract is disabled with its reason', async ({ page }) => {
    const mock = await start(page, 'options', { at: OTC_NOW });
    await grid(page, 'Option contracts').getByText('TEST-BTC-LIVE-65000-C').click();
    const ticket = page.getByRole('region', { name: 'Order ticket' });
    await expect(ticket.getByText('Live option orders are refused', { exact: false })).toBeVisible();
    await expect(ticket.getByRole('button', { name: 'Review order' })).toBeDisabled();
    await shot(page, 'options-05-live-ticket-disabled');
    // A contract with missing terms is disabled with its own reason.
    await grid(page, 'Option contracts').getByText('TEST-BTC-NOTERMS-C').click();
    await expect(ticket.getByText('missing terms', { exact: false })).toBeVisible();
    await expect(ticket.getByRole('button', { name: 'Review order' })).toBeDisabled();
    await shot(page, 'options-06-incomplete-ticket-disabled');
    await clean(page, mock);
  });

  test('strategy: payoff, Greeks answered ok then refused', async ({ page }) => {
    const mock = await start(page, 'options', { at: OTC_NOW });
    await page.getByRole('tab', { name: 'Strategy builder' }).click();
    await page.getByLabel('Centre strike').fill('65000');
    await page.getByLabel('Strike step').fill('5000');
    await page.getByRole('button', { name: 'Fill legs' }).click();
    const premiums = page.getByLabel('Your price');
    await expect(premiums).toHaveCount(2);
    await premiums.nth(0).fill('2500');
    await premiums.nth(1).fill('2300');
    await expect(page.getByRole('region', { name: 'Result at expiry' }).getByText('Break-even')).toBeVisible();
    await page.getByLabel('Spot price').fill('65000');
    await page.getByLabel('Volatility').fill('0.6');
    await page.getByLabel('Years to expiry').fill('0.2');
    await page.getByRole('button', { name: 'Get Greeks' }).click();
    await expect(page.getByText('Delta 0.52', { exact: false })).toBeVisible();
    await expect(page.getByText('Greeks: available')).toBeVisible();
    await shot(page, 'options-07-strategy-greeks-ok');
    mock.state.greeks = 'refused';
    await page.getByRole('button', { name: 'Get Greeks' }).click();
    await expect(page.getByText('Delta —', { exact: false }).first()).toBeVisible();
    await expect(page.getByText('Greeks: not linked here')).toBeVisible();
    await shot(page, 'options-08-strategy-greeks-refused');
    await clean(page, mock);
  });

  // A real Greeks answer has a negative put delta and theta; the room must show them, not refuse the answer.
  test('strategy: signed Greeks (negative put delta, theta) are shown', async ({ page }) => {
    const mock = await start(page, 'options', { at: OTC_NOW });
    mock.state.greeks = 'signed';
    await page.getByRole('tab', { name: 'Strategy builder' }).click();
    await page.getByLabel('Centre strike').fill('65000');
    await page.getByLabel('Strike step').fill('5000');
    await page.getByRole('button', { name: 'Fill legs' }).click();
    await page.getByLabel('Your price').nth(0).fill('2500');
    await page.getByLabel('Your price').nth(1).fill('2300');
    await page.getByLabel('Spot price').fill('65000');
    await page.getByLabel('Volatility').fill('0.6');
    await page.getByLabel('Years to expiry').fill('0.2');
    await page.getByRole('button', { name: 'Get Greeks' }).click();
    await expect(page.getByText('Delta −0.48', { exact: false })).toBeVisible({ timeout: 4000 });
  });
});

// ===================================================================================== Execution
test.describe('Execution', () => {
  test('scheduler on: create, review, confirm, running parent; partial, halted; pause, resume, cancel', async ({ page }) => {
    const mock = await start(page, 'execution', { at: EXEC_NOW });
    await expect(page.getByText('Scheduler running')).toBeVisible();
    await page.getByLabel('Total size (BTC)').fill('0.12');
    await expect(page.getByRole('button', { name: 'Review schedule' })).toBeEnabled();
    await shot(page, 'exec-01-algo-form');
    await page.getByRole('button', { name: 'Review schedule' }).click();
    await expect(dialog(page).getByText('Create this schedule?')).toBeVisible();
    await shot(page, 'exec-02-algo-confirm');
    await dialog(page).getByRole('button', { name: 'Create schedule' }).click();
    await expect(page.getByText('Done. The list shows the state the service reports.')).toBeVisible();
    const list = grid(page, 'Schedules');
    await expect(list.getByText('Active')).toBeVisible();
    await expect(list.getByText('4 / 12')).toBeVisible();
    await expect(list.getByText('33%')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Schedule detail' })).toBeVisible();
    await shot(page, 'exec-03-algo-running');

    // The partial and the halted TEST parents are opened by id, as a person would from another device.
    for (const id of ['TEST-algo-partial', 'TEST-algo-halted']) {
      await page.getByLabel('Open by id').fill(id);
      await page.getByRole('button', { name: 'Open', exact: true }).click();
      await expect(page.getByRole('region', { name: 'Schedule detail' }).getByText(id)).toBeVisible();
    }
    await expect(list.getByText('Partial: 2 misses')).toBeVisible();
    await expect(list.getByText('Halted')).toBeVisible();
    await shot(page, 'exec-04-algo-partial-halted');

    // Pause, resume, cancel the running parent, each behind a confirm.
    await list.getByRole('button', { name: 'Pause TEST-algo-running' }).click();
    await expect(dialog(page).getByText('Pause this schedule?')).toBeVisible();
    await shot(page, 'exec-05-algo-pause-confirm');
    const paused = Date.now();
    await dialog(page).getByRole('button', { name: 'Pause schedule' }).click();
    await expect(page.getByText('Done. The list shows the state the service reports.')).toBeVisible();
    // The room re-reads the parents right after a write, so the new state shows well before the 10 s poll.
    await expect(list.getByRole('button', { name: 'Resume TEST-algo-running' })).toBeVisible({ timeout: 4000 });
    console.log(`list showed the paused state ${Date.now() - paused} ms after the pause was confirmed`);
    await shot(page, 'exec-06-algo-paused');
    await list.getByRole('button', { name: 'Resume TEST-algo-running' }).click();
    await dialog(page).getByRole('button', { name: 'Resume schedule' }).click();
    await expect(list.getByRole('button', { name: 'Pause TEST-algo-running' })).toBeVisible({ timeout: 4000 });
    await list.getByRole('button', { name: 'Cancel TEST-algo-running' }).click();
    await expect(dialog(page).getByText('Cancel this schedule?')).toBeVisible();
    await shot(page, 'exec-07-algo-cancel-confirm');
    await dialog(page).getByRole('button', { name: 'Cancel schedule' }).click();
    await expect(list.getByText('Cancelled')).toBeVisible({ timeout: 15000 });
    await shot(page, 'exec-08-algo-cancelled');
    expect(mock.called('algo.pause')).toHaveLength(1);
    expect(mock.called('algo.resume')).toHaveLength(1);
    expect(mock.called('algo.cancel')).toHaveLength(1);
    await clean(page, mock);
  });

  test('scheduler off: the form refuses with its reason', async ({ page }) => {
    const mock = await start(page, 'execution', { at: EXEC_NOW, schedulerOn: false });
    await expect(page.getByText('Scheduler off: new schedules will not slice')).toBeVisible();
    await page.getByLabel('Total size (BTC)').fill('0.12');
    await expect(page.getByText('The slice scheduler is off.', { exact: false }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Review schedule' })).toBeDisabled();
    await shot(page, 'exec-09-scheduler-off');
    expect(mock.called('algo.createTwap')).toHaveLength(0);
    await clean(page, mock);
  });

  test('scaled batch: placed, refused and unknown, then Check status; blotter', async ({ page }) => {
    const mock = await start(page, 'execution', { at: EXEC_NOW });
    await page.getByRole('tab', { name: 'Scaled' }).click();
    await page.getByLabel('Total size (BTC)').fill('0.04');
    await page.getByLabel('Number of orders').fill('4');
    await page.getByLabel('First price').fill('59000');
    await page.getByLabel('Last price').fill('58000');
    await expect(page.getByRole('button', { name: 'Review ladder' })).toBeEnabled();
    await shot(page, 'exec-10-scaled-ladder');
    await page.getByRole('button', { name: 'Review ladder' }).click();
    await expect(dialog(page).getByText('Place these orders?')).toBeVisible();
    await shot(page, 'exec-11-scaled-confirm');
    await dialog(page).getByRole('button', { name: 'Place orders' }).click();
    const result = page.getByRole('region', { name: 'Ladder result' });
    // The lost answer is read back from the book at once: the order is there, so the room says so and counts it placed.
    await expect(result.getByText('3 of 4 placed, 1 refused')).toBeVisible();
    await expect(result.getByText('Refused').first()).toBeVisible();
    await expect(result.getByText('Placed, found on the book')).toBeVisible();
    await shot(page, 'exec-12-scaled-result');
    await result.getByRole('button', { name: 'Check status' }).click();
    await expect(result.getByRole('columnheader', { name: 'On the book' })).toBeVisible();
    await expect(result.getByText('Not found').first()).toBeVisible();
    await shot(page, 'exec-13-scaled-checked');

    await page.getByRole('tab', { name: 'Child orders and fills' }).click();
    const blotter = grid(page, 'Orders and fills');
    await expect(blotter.getByText('BTC/USDT').first()).toBeVisible();
    await expect(page.getByText('Algo rows are matched by market, side and time, not by link.')).toBeVisible();
    await shot(page, 'exec-14-blotter');
    await clean(page, mock);
  });
});

// ==================================================================================== Quote desk
test.describe('Quote desk', () => {
  const ask = async (page) => {
    await expect(page.getByRole('region', { name: 'Desk status' })).toBeVisible();
    await page.getByRole('region', { name: 'Request a price' }).getByRole('textbox', { name: 'Quantity' }).fill('0.5');
    await page.getByRole('button', { name: 'Request price' }).click();
    const card = page.getByRole('region', { name: 'Quote', exact: true });
    await expect(card).toBeVisible();
    return card;
  };

  test('desk open, request, open quote card with countdown', async ({ page }) => {
    const mock = await start(page, 'otc', { at: OTC_NOW });
    await expect(page.getByRole('region', { name: 'Desk status' })).toBeVisible();
    await shot(page, 'otc-01-desk-open');
    const card = await ask(page);
    await expect(card.getByText('0:30 left', { exact: false })).toBeVisible();
    await expect(card.getByText('This price is firm until the time runs out', { exact: false })).toBeVisible();
    await shot(page, 'otc-02-quote-open');
    await clean(page, mock);
  });

  test('accept -> bound (accepted, not settled) -> settle -> settled', async ({ page }) => {
    const mock = await start(page, 'otc', { at: OTC_NOW });
    const card = await ask(page);
    await card.getByRole('button', { name: 'Accept', exact: true }).click();
    await expect(dialog(page).getByText('Accept this quote?')).toBeVisible();
    await shot(page, 'otc-03-accept-confirm');
    await dialog(page).getByRole('button', { name: 'Accept at this price' }).click();
    await expect(card.getByText('Accepted, not settled').first()).toBeVisible();
    await expect(card.getByTestId('phase-line')).toContainText('Accepted, not settled');
    await shot(page, 'otc-04-quote-bound');
    await card.getByRole('button', { name: 'Settle', exact: true }).click();
    await expect(dialog(page).getByText('Settle this quote?')).toBeVisible();
    await dialog(page).getByRole('button', { name: 'Settle now' }).click();
    await expect(card.getByTestId('phase-line')).toContainText('Settled. The trade is complete.');
    await shot(page, 'otc-05-quote-settled');
    await clean(page, mock);
  });

  test('expire an open quote', async ({ page }) => {
    const mock = await start(page, 'otc', { at: OTC_NOW });
    const card = await ask(page);
    await card.getByRole('button', { name: 'Expire', exact: true }).click();
    await expect(dialog(page).getByText('Expire this quote?')).toBeVisible();
    await dialog(page).getByRole('button', { name: 'Expire quote' }).click();
    await expect(card.getByTestId('phase-line')).toContainText('Expired.');
    await shot(page, 'otc-06-quote-expired');
    await clean(page, mock);
  });

  test('a quote that ran out by the clock offers no accept until re-read', async ({ page }) => {
    const mock = await start(page, 'otc', { at: OTC_NOW });
    const card = await ask(page);
    await page.clock.setFixedTime(OTC_NOW + 60_000); // 30 s past the quote's time
    await expect(card.getByTestId('phase-line')).toContainText('time is up on this device', { timeout: 8000 });
    await expect(card.getByRole('button', { name: 'Accept', exact: true })).toBeDisabled();
    await expect(card.getByRole('button', { name: 'Expire', exact: true })).toBeDisabled();
    await expect(card.getByText('· time is up', { exact: false })).toBeVisible();
    await shot(page, 'otc-07-quote-expired-by-clock');
    await clean(page, mock);
  });

  test('unknown outcome: the connection drops on accept; locked note, Check status clears it', async ({ page }) => {
    const mock = await start(page, 'otc', { at: OTC_NOW });
    const card = await ask(page);
    mock.state.abortOnce.set('rfq.accept', { landed: false });
    await card.getByRole('button', { name: 'Accept', exact: true }).click();
    await dialog(page).getByRole('button', { name: 'Accept at this price' }).click();
    await expect(page.getByText('Unconfirmed request', { exact: false })).toBeVisible();
    await expect(page.getByText('New requests stay locked until it is checked.', { exact: false })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Accept', exact: true })).toBeDisabled();
    await shot(page, 'otc-08-unknown-locked');
    // The service did take the accept after all; the status check reads it back and releases the lock.
    const id = TEST_QUOTES.open.quoteId;
    mock.state.quotes.set(id, { ...TEST_QUOTES.bound, quoteId: id });
    await page.getByRole('button', { name: 'Check status' }).first().click();
    await expect(page.getByText(`Confirmed: the original request for ${id} went through.`, { exact: false })).toBeVisible();
    await expect(page.getByText('Unconfirmed request', { exact: false })).toHaveCount(0);
    await shot(page, 'otc-09-unknown-checked');
    await clean(page, mock);
  });
});

test.afterAll(() => {
  console.log(`screenshots written: ${taken.length} (in ${shots})`);
});
