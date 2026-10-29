import { test, expect } from '@playwright/test';
import { api, journeyState, toUnits, tool } from './stack.mjs';
import { fundedTrader, signIn } from './desk.mjs';

// J-more-catalogue-16, in the running app (docs/roadmap/journeys.json): manage my orders and positions until a market
// settles. One test per step, titled "J-more-catalogue-16 #<n>", run in order on one verified TEST account with TEST 100
// USDT. #1 looks before any position exists; #2 seeds two TEST markets with resting orders and positions for the person
// (`local-test-world.mjs predict-markets --positions`), and the determination comes from the stack's TEST oracle
// (`local-test-world.mjs predict-determine`). Every hold, release and payout is read back from the ledger.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - #1: /predict/positions has no cash line read from the ledger.
// - #2 to #8: no Predict service runs on the stack (an owner decision) and the stack has no market seed or oracle; so
//   no positions, cancels, decreases, queue position, closes, disputes or settlement.
const J = 'J-more-catalogue-16';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const UNBUILT = { timeout: 5_000 };

test.describe.configure({ mode: 'default' });
// An action on a part that never appears fails in 15 s, not at the test's time limit.
test.use({ actionTimeout: 15_000 });

function state(key) {
  const value = run.read()[key];
  if (!value) throw new Error(`${J}: an earlier step made no ${key}, so this step has nothing to act on`);
  return value;
}

const room = (page) => page.locator('#main');
const free = async (who) => toUnits((await (await api(who)).balances()).USDT?.free ?? '0');
const positions = (page) => room(page).getByRole('table', { name: 'Positions' });
const orders = (page) => room(page).getByRole('table', { name: 'Open orders' });

async function openPositions(page) {
  await signIn(page, state('trader'));
  await page.goto('/predict/positions');
  await expect(positions(page)).toBeVisible(UNBUILT);
}

test(`${J} #1 opens /predict/positions with nothing: the empty state and my cash line from the ledger; no portfolio number`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const trader = await fundedTrader(page, 'jpp', '100');
  run.reset({ trader });
  await signIn(page, trader);
  await page.goto('/predict/positions');
  await expect(room(page).getByText(/Cash\s*100(\.0+)? USDT/)).toBeVisible(UNBUILT);
  await expect(room(page).getByText(/No positions/)).toBeVisible();
});

test(`${J} #2 opens it with positions in two markets: quantity and cost as decimal strings; unfilled orders apart`, async ({ page }) => {
  const seeded = JSON.parse(tool('local-test-world.mjs', 'predict-markets', '--count', '2', '--positions', state('trader').email));
  run.write({ markets: seeded.ids });
  await openPositions(page);
  await expect(positions(page).locator('tbody tr')).toHaveCount(2);
  await expect(orders(page)).toBeVisible();
});

test(`${J} #3 cancels a resting order, pressing twice: it leaves the book; collateral released once`, async ({ page }) => {
  const trader = state('trader');
  await openPositions(page);
  const before = await free(trader);
  await orders(page).locator('tbody tr').first().getByRole('button', { name: 'Cancel' }).dblclick();
  expect((await free(trader)) - before).toBe(toUnits('4'));
});

test(`${J} #4 decreases a partly filled order, then cancels all: each release under its own key`, async ({ page }) => {
  await openPositions(page);
  await orders(page).locator('tbody tr').first().getByRole('button', { name: 'Decrease' }).click();
  await room(page).getByRole('button', { name: 'Cancel all' }).click();
  await expect(orders(page).locator('tbody tr')).toHaveCount(0);
});

test(`${J} #5 reads the queue position and the order and fill history`, async ({ page }) => {
  await openPositions(page);
  await expect(room(page).getByRole('table', { name: 'Order and fill history' })).toBeVisible();
});

test(`${J} #6 a market closes with resting orders: the system cancels them; it stays closed until determined`, async ({ page }) => {
  tool('local-test-world.mjs', 'predict-close', state('markets')[1]);
  await openPositions(page);
  await expect(room(page).getByText(/Closed, waiting for the outcome/)).toBeVisible();
});

test(`${J} #7 disputes a determination or reads the oracle source: reporter, oracle source, dispute rounds and bond`, async ({ page }) => {
  await signIn(page, state('trader'));
  await page.goto(`/predict/${encodeURIComponent(state('markets')[0])}`);
  await expect(room(page).getByRole('region', { name: 'Resolution' })).toContainText(/Oracle source/, UNBUILT);
});

test(`${J} #8 a market is determined yes: winners paid once; settled history shows timing and payout`, async ({ page }) => {
  const trader = state('trader');
  const before = await free(trader);
  tool('local-test-world.mjs', 'predict-determine', state('markets')[0], 'yes');
  tool('local-test-world.mjs', 'predict-determine', state('markets')[0], 'yes');
  expect((await free(trader)) - before).toBeGreaterThan(0n);
  await openPositions(page);
  await expect(room(page).getByRole('table', { name: 'Settled' })).toBeVisible();
});
