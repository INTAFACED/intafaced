import { test, expect } from '@playwright/test';
import { UNBUILT, dexRun } from './dex.mjs';
import { fundedTrader, signIn } from './desk.mjs';
import { api } from './stack.mjs';
import { bodyRows, tableIn } from './tables.mjs';

// J-dex-protocol-19, in the running app (docs/roadmap/journeys.json): use the advanced futures controls: portfolio
// margin, the two books and market health. One test per step, titled "J-dex-protocol-19 #<n>", run in order on one
// verified TEST account with an open TEST perpetual position and the Protocol-native row visible. Custodial ledger
// recipes only; the Protocol-native book places nothing yet; a blank safety limit refuses and never reads "no limit".
// chain.go for the Protocol-native book; owner.decision for the portfolio margin threshold and scenario set.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - the futures desk (/trade/futures) opens a TEST position (J-derivatives-01) and its Portfolio margin mode refuses
//   "not offered", but there is no close-positions-first refusal or portfolio margin,
//   portfolio ratio or auto-borrow (D-perps-05), no mark-source and liquidation-rules panel (D-perps-04), no
//   Protocol-native book row, open-interest cap, price band or kill switch (D-perps-06) and no market health readings
//   (D-perps-06, -07);
// - #1's second clause (no positions and the threshold blank) is read on a second TEST account with nothing open.
const J = 'J-dex-protocol-19';
const account = dexRun(J);
const DESK = '/trade/futures';
const SYMBOL = 'BTC/USDT:USDT';

test.describe.configure({ mode: 'default' });

const main = (page) => page.getByRole('main');

/** Signs `who` in and opens the futures desk. */
async function desk(page, who = account.run.read().who) {
  expect(who, 'the start step made the account').toBeTruthy();
  await signIn(page, who);
  await page.goto(DESK);
  await expect(page.getByRole('button', { name: 'Open long' })).toBeVisible();
  return who;
}

/** Types a size and the TEST leverage in the ticket and presses Review, as the desk asks before an open. */
async function fillTicket(page, size, { review = true } = {}) {
  const ticket = page.getByRole('region', { name: 'Order ticket' });
  await ticket.getByRole('textbox', { name: 'Size' }).fill(size);
  await ticket.getByRole('textbox', { name: 'Leverage' }).fill('5');
  if (review) await ticket.getByRole('button', { name: 'Review', exact: true }).click({ timeout: 15_000 });
  return ticket;
}

/** Confirms the open sheet, accepting a new margin tier, and waits for the fill (J-derivatives-01 #8). */
async function confirmOpen(page) {
  const confirm = page.getByRole('alertdialog');
  const tier = confirm.getByRole('region', { name: 'New margin tier' });
  const filled = page.getByText('Order filled');
  for (let attempt = 0; attempt < 2 && !(await filled.isVisible()); attempt++) {
    if ((await tier.count()) > 0) await tier.getByRole('checkbox').click();
    await confirm.getByRole('button', { name: 'Confirm open long' }).click();
    await expect(filled.or(confirm.getByText('The numbers moved since you reviewed'))).toBeVisible({ timeout: 20_000 });
  }
  await expect(filled).toBeVisible();
}

/** Picks a contract in the desk's contract chooser. */
async function chooseContract(page, name) {
  await page.getByRole('combobox', { name: 'Choose a contract' }).click();
  await page.getByRole('option', { name }).click(UNBUILT);
}

test(`${J} starts: a verified TEST account with an open TEST futures position`, async ({ page }) => {
  test.setTimeout(300_000);
  const who = await fundedTrader(page, 'dex19', '1000');
  const empty = await fundedTrader(page, 'dex19e', '10');
  account.run.reset({ who, empty });
  await desk(page, who);
  await fillTicket(page, '0.01');
  await page.getByRole('button', { name: 'Open long' }).click(UNBUILT);
  await confirmOpen(page);
  await expect.poll(async () => ((await (await api(who)).get('/api/v1/positions')).body ?? []).length, { timeout: 20_000 }).toBe(1);
});

test(`${J} #1 presses Enable portfolio margin with open positions: close positions first; with none open and the threshold blank "portfolio margin not set"`, async ({
  page,
}) => {
  // The desk's margin mode chooser has Portfolio; today it refuses "not offered" whether or not positions are open.
  const portfolio = (page) => page.getByRole('group', { name: 'Margin mode' }).getByRole('button', { name: 'Portfolio' });
  await desk(page);
  await portfolio(page).click();
  await expect(main(page).getByText(/Close your open positions first/)).toBeVisible(UNBUILT);
  await desk(page, account.run.read().empty);
  await portfolio(page).click();
  await expect(main(page).getByText(/portfolio margin (is )?not set/i)).toBeVisible(UNBUILT);
});

test(`${J} #2 reads the portfolio ratio: with a published scenario set the ratio and its inputs; with portfolio margin off the refusal`, async ({
  page,
}) => {
  await desk(page);
  const ratio = main(page).getByRole('region', { name: 'Portfolio ratio' });
  await expect(ratio).toBeVisible(UNBUILT);
  // Portfolio margin is off for this account: the ratio is refused, never a number.
  await expect(ratio).toContainText('Portfolio margin is off for this account.');
  await expect(ratio.getByTestId('portfolio-ratio')).toHaveCount(0);
});

test(`${J} #3 turns on auto-borrow with the rate blank: "Auto-borrow rate not set"`, async ({ page }) => {
  await desk(page);
  await main(page).getByRole('switch', { name: 'Auto-borrow' }).click(UNBUILT);
  await expect(main(page).getByRole('alert')).toContainText('Auto-borrow rate not set');
  await expect(main(page).getByRole('switch', { name: 'Auto-borrow' })).not.toBeChecked();
});

test(`${J} #4 reads the funding rate and the mark source: the accepted mark and its age; never an invented mark`, async ({ page }) => {
  await desk(page);
  const mark = main(page).getByRole('region', { name: 'Mark source' });
  await expect(mark).toBeVisible(UNBUILT);
  await expect(mark.getByTestId('accepted-mark')).toHaveText(/^[\d,]+\.\d+ · \d+ s old$|^No accepted mark: .+/);
  await expect(mark.getByRole('term').filter({ hasText: 'Funding rate' })).toBeVisible();
});

test(`${J} #5 reads the liquidation and auto-deleveraging rules: with the ladder unset "liquidation is not running"; with the policy unset past events still list`, async ({
  page,
}) => {
  await desk(page);
  const rules = main(page).getByRole('region', { name: 'Liquidation rules' });
  await expect(rules).toBeVisible(UNBUILT);
  await expect(rules).toContainText('liquidation is not running');
  await page.getByRole('tab', { name: 'ADL and liquidations' }).click();
  await expect(tableIn(main(page), 'Past liquidation events').getByRole('columnheader', { name: 'Time' })).toBeVisible();
});

test(`${J} #6 opens the Protocol-native book: the row shows the chain.go blocker and no order can be placed`, async ({ page }) => {
  await desk(page);
  const books = main(page).getByRole('radiogroup', { name: 'Book' });
  await expect(books.getByRole('radio', { name: /^Protocol-native/ })).toBeVisible(UNBUILT);
  await expect(books.getByRole('radio', { name: /^Protocol-native/ })).toBeDisabled();
  await expect(main(page).getByRole('note').filter({ hasText: 'Protocol-native' })).toContainText('chain.go');
});

test(`${J} #7 places an order into a thin market with the open-interest cap unset: refused "open-interest cap not set", a safety control`, async ({
  page,
}) => {
  await desk(page);
  await chooseContract(page, 'TEST thin perp');
  await fillTicket(page, '0.01');
  await page.getByRole('button', { name: 'Open long' }).click(UNBUILT);
  await expect(page.getByRole('alert')).toContainText('open-interest cap not set');
});

test(`${J} #8 places a limit order outside the published band: refused with the band; at limit-only, market orders refuse and limit orders queue`, async ({
  page,
}) => {
  await desk(page);
  const types = page.getByRole('group', { name: 'Order type' });
  await types.getByRole('button', { name: 'Limit' }).click();
  await page.getByRole('textbox', { name: 'Limit price' }).fill('1');
  await fillTicket(page, '0.01');
  await page.getByRole('button', { name: 'Open long' }).click(UNBUILT);
  await expect(page.getByRole('alert')).toContainText(/outside the price band [\d,.]+ to [\d,.]+/, UNBUILT);
  // The TEST kill switch at limit-only: a market order refuses, a limit inside the band queues.
  await chooseContract(page, 'TEST limit-only perp');
  await types.getByRole('button', { name: 'Market' }).click();
  await page.getByRole('button', { name: 'Open long' }).click(UNBUILT);
  await expect(page.getByRole('alert')).toContainText('This market takes limit orders only');
});

test(`${J} #9 reads market health: open interest, skew, liquidity flag and the safety flags, with the as-of time`, async ({ page }) => {
  await desk(page);
  const health = main(page).getByRole('region', { name: 'Market health' });
  await expect(health).toBeVisible(UNBUILT);
  for (const term of ['Open interest', 'Skew', 'Liquidity', 'Safety flags'])
    await expect(health.getByRole('term').filter({ hasText: term })).toBeVisible();
  await expect(health.getByTestId('health-as-of')).toHaveText(/^As of \d{2}:\d{2}:\d{2}/);
  await expect(bodyRows(tableIn(main(page), 'Perpetuals')).filter({ hasText: SYMBOL })).toHaveCount(1);
});
