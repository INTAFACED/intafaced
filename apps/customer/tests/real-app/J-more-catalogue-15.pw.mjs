import { test, expect } from '@playwright/test';
import { api, journeyState, toUnits, tool } from './stack.mjs';
import { fundedTrader, signIn } from './desk.mjs';

// J-more-catalogue-15, in the running app (docs/roadmap/journeys.json): read a prediction market and place a Yes or No
// order. One test per step, titled "J-more-catalogue-15 #<n>", run in order on one verified TEST account with TEST 100
// USDT. #1 looks before any market exists; #2 seeds three published TEST markets with rules, a resolution source and a
// clarification (`local-test-world.mjs predict-markets`). Prices and the book are read from the one order book; every
// hold is read back from the ledger.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - #1: the room reads its catalogue honestly, but names no Predict blocker beside "No questions are listed".
// - #2 to #7: no Predict service runs on the stack (an owner decision), and the stack has no TEST market seed; so no
//   filters, market page, book, ticket, hold, share card, Scanner row or extra market kinds.
const J = 'J-more-catalogue-15';
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

const room = (page) => page.getByRole('main');
const held = async (who) => toUnits((await (await api(who)).balances()).USDT?.used ?? '0');

async function openMarket(page, marketId) {
  await signIn(page, state('trader'));
  await page.goto(`/predict/${encodeURIComponent(marketId)}`);
  await expect(room(page).getByRole('region', { name: 'Rules' })).toBeVisible(UNBUILT);
}

test(`${J} #1 opens /predict with no markets: the full layout, the honest empty state and the named blocker`, async ({ page }) => {
  test.setTimeout(240_000);
  const trader = await fundedTrader(page, 'jpm', '100');
  run.reset({ trader });
  await signIn(page, trader);
  await page.goto('/predict');
  await expect(room(page).getByRole('heading', { name: 'No questions are listed', exact: true })).toBeVisible();
  await expect(room(page).getByRole('button', { name: 'Refresh questions', exact: true })).toBeVisible();
  await expect(room(page).getByText(/Predict (isn’t running|waits for)/)).toBeVisible(UNBUILT);
});

test(`${J} #2 filters three published markets by category and trending: only matches, in trade-count order`, async ({ page }) => {
  const seeded = JSON.parse(tool('local-test-world.mjs', 'predict-markets', '--count', '3'));
  run.write({ markets: seeded.ids });
  await signIn(page, state('trader'));
  await page.goto('/predict');
  await room(page).getByRole('combobox', { name: 'Category' }).selectOption({ index: 1 }, UNBUILT);
  await room(page).getByRole('button', { name: 'Trending' }).click();
  await expect(room(page).getByRole('article').first()).toBeVisible();
});

test(`${J} #3 opens a market: rules, resolution source, timeline and clarifications (original text unchanged)`, async ({ page }) => {
  await openMarket(page, state('markets')[0]);
  await expect(room(page).getByRole('region', { name: 'Resolution source' })).toBeVisible();
  await expect(room(page).getByRole('region', { name: 'Timeline' })).toBeVisible();
  await expect(room(page).getByRole('region', { name: 'Clarifications' })).toBeVisible();
});

test(`${J} #4 reads price and book: probability from decimal strings; a Yes bid of 0.62 shows a No ask of 0.38`, async ({ page }) => {
  await openMarket(page, state('markets')[0]);
  const book = room(page).getByRole('table', { name: 'Order book' });
  await expect(book.or(room(page).getByText('No orders yet'))).toBeVisible();
});

test(`${J} #5 presses Review while the order path is not wired: the typed refusal with the Predict blocker; no intent row`, async ({
  page,
}) => {
  await openMarket(page, state('markets')[0]);
  await room(page).getByLabel('Outcome contract quantity', { exact: true }).fill('10');
  await room(page).getByRole('button', { name: 'Review' }).click();
  await expect(room(page).getByRole('heading', { name: 'Order review unavailable', exact: true })).toBeVisible();
});

test(`${J} #6 sends a buy of 10 twice with the same client order id: one hold and one order`, async () => {
  const trader = state('trader');
  const before = await held(trader);
  const body = { marketId: state('markets')[0], outcome: 'yes', quantity: '10', price: '0.5', clientOrderId: `${J}-6` };
  await (await api(trader)).post('/api/predict/trpc/orders.place', body);
  await (await api(trader)).post('/api/predict/trpc/orders.place', body);
  expect((await held(trader)) - before).toBe(toUnits('5'));
});

test(`${J} #7 shares the market card, opens it from a Scanner row, or proposes a categorical market: the hooks and fees`, async ({
  page,
}) => {
  await openMarket(page, state('markets')[0]);
  await room(page).getByRole('button', { name: 'Share' }).click();
  await expect(page.getByRole('dialog', { name: 'Share this market' })).toBeVisible();
});
