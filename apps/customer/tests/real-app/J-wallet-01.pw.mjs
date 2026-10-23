import { test, expect } from '@playwright/test';
import { api, fund, journeyState, toUnits } from './stack.mjs';
import { awayBid, confirm, deskPath, free, held, openDesk, openOrders, reviewLimit, signIn, signUp, verify } from './desk.mjs';

// J-wallet-01, in the running app (docs/roadmap/journeys.json): I see what I hold and what I can actually withdraw.
// One test per step, titled "J-wallet-01 #<n>", run in order on one verified TEST account funded with TEST 500 USDT.
// Every figure on screen is checked against the ledger through the customer's own API. Not here yet: #4 needs an
// asset with no published price (every asset on the local stack has a market), #5 an asset and network list, and #6
// the membership tier on Account (identity's).
const J = 'J-wallet-01';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });

function account() {
  const who = run.read().account;
  if (!who) throw new Error(`${J} #1 made no account, so this step has no one to act as`);
  return who;
}

const balances = async () => (await api(account())).balances();
/** The ledger's decimal as the Money table prints it: thousands grouped, no trailing zeros (no float near money). */
const shown = (decimal) => {
  const [whole, frac] = decimal.split('.');
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${frac && /[1-9]/.test(frac) ? `.${frac.replace(/0+$/, '')}` : ''}`;
};
const usdtRow = (page) => page.locator('tr', { has: page.locator('[data-col="available"]') }).filter({ hasText: 'Tether' });

/** The USDT row on Money shows Available, In orders and Locked as the ledger holds them, and they add up to its total. */
async function moneyAgreesWithLedger(page) {
  const usdt = (await balances()).USDT;
  await page.goto('/money');
  // A pointer left on the top bar keeps its hover menu open over the page; move it off, as a person would.
  await page.mouse.move(0, 600);
  const row = usdtRow(page);
  await expect(row.locator('[data-col="available"]')).toHaveText(shown(usdt.free));
  await expect(row.locator('[data-col="in-orders"]')).toHaveText(shown(usdt.used));
  await expect(row.locator('[data-col="locked"]')).toHaveText('0');
  await expect(row).toContainText(`${shown(usdt.total)} USDT`);
  expect(toUnits(usdt.free) + toUnits(usdt.used)).toBe(toUnits(usdt.total));
  return usdt;
}

test(`${J} #1 opens Assets: available, in orders and locked add up to the ledger total`, async ({ page }) => {
  const who = await signUp(page, 'jw');
  await verify(page, who);
  expect(fund(who.email, 'USDT', '500').tx).toBeTruthy();
  run.reset({ account: who });
  await signIn(page, who);
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Assets' }).click();
  await expect(page).toHaveURL(/\/money(\?|$)/);
  const usdt = await moneyAgreesWithLedger(page);
  expect(usdt).toMatchObject({ free: expect.stringMatching(/^500(\.0+)?$/), total: expect.stringMatching(/^500(\.0+)?$/) });
  // Grouped by kind of wallet place: what can be spent and what is locked.
  await page.getByRole('button', { name: 'Place' }).click();
  await expect(page.getByText('Spendable').first()).toBeVisible();
});

test(`${J} #2 places an order: its hold names the order, and cancelling it returns the amount to available`, async ({ page }) => {
  const who = account();
  await openDesk(page, who);
  await reviewLimit(page, 'buy', await awayBid(90), '0.002');
  await confirm(page, 'buy');
  const [order] = await openOrders(who);
  expect(order?.id).toBeTruthy();
  const short = order.id.slice(0, 8);

  // Money: the hold is In orders, and the cell names the order behind it.
  const usdt = await moneyAgreesWithLedger(page);
  expect(toUnits(usdt.used)).toBeGreaterThan(0n);
  await expect(usdtRow(page).locator('[data-col="in-orders"]')).toHaveAttribute('title', `Open order ${short}: ${usdt.used}`);

  // The coin's balance page lists the hold as its own line, by the order, and adds everything back to the balance.
  await page.goto('/money/balance/USDT');
  const lines = page.getByTestId('set-aside');
  await expect(lines.locator('tr', { hasText: `Open order ${short}` })).toContainText(`${shown(usdt.used)} USDT`);
  await expect(lines.locator('td', { hasText: `Open order ${short}` })).toHaveAttribute('title', order.id);
  await expect(page.getByTestId('set-aside-sum')).toHaveText(
    `Available ${shown(usdt.free)} + set aside ${shown(usdt.used)} = ${shown(usdt.total)} USDT, all the USDT in your main account.`,
  );

  // Cancel on the desk (still signed in): the hold goes back to available, once.
  await page.goto(deskPath());
  await page.locator('[role=tab]', { hasText: 'Open orders' }).click();
  await page.locator('tr', { hasText: 'Cancel' }).first().getByRole('button', { name: 'Cancel' }).click();
  await expect.poll(async () => (await openOrders(who)).length).toBe(0);
  const after = await moneyAgreesWithLedger(page);
  expect(held(await balances(), 'USDT')).toBe(0n);
  expect(after.free).toBe(after.total);
  await page.goto('/money/balance/USDT');
  await expect(page.getByText('Nothing of your USDT is set aside right now.')).toBeVisible();
});

test(`${J} #3 opens Withdraw: it offers only what is available, and a card or bank purchase is refused with its blocker`, async ({
  page,
}) => {
  const who = account();
  // A resting order holds part of the balance again, so Withdraw must leave it out.
  await openDesk(page, who);
  await reviewLimit(page, 'buy', await awayBid(90), '0.002');
  await confirm(page, 'buy');
  const before = await balances();
  expect(held(before, 'USDT')).toBeGreaterThan(0n);
  await page.goto('/uc/withdraw');
  await expect(page.getByText(`Available: ${shown(before.USDT.free)} USDT`)).toBeVisible();
  // Card and bank purchases need a payment partner; the page says so and nothing is held for them.
  await page.goto('/uc/recharge');
  const main = page.locator('main').first();
  await expect(main).toContainText('Needs a payment partner, which is not connected.');
  const after = await balances();
  expect(free(after, 'USDT')).toBe(free(before, 'USDT'));
  expect(held(after, 'USDT')).toBe(held(before, 'USDT'));
});
