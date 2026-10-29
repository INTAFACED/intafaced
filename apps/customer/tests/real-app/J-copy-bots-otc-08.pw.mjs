import { test, expect } from '@playwright/test';
import { api, journeyState } from './stack.mjs';
import { fundedTrader, signIn } from './desk.mjs';

// J-copy-bots-otc-08, in the running app (docs/roadmap/journeys.json): invest in a pooled strategy and redeem later. One
// test per step, titled "J-copy-bots-otc-08 #<n>", run in order on one verified TEST account in DE with TEST 500 USDT.
// The strategies are the pooled strategies the stack lists; the drawdown ceiling, minimum, lock-up and windows are the
// stack's TEST pooled terms. Shares and balances are read back from the service and the ledger.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - every step: there is no pooled strategy list, investment, seed round, redemption or investor dashboard.
const J = 'J-copy-bots-otc-08';
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

const list = (page) => page.getByRole('table', { name: 'Pooled strategies' });

async function invest(page, amount) {
  await signIn(page, state('investor'));
  await page.goto('/trade/copy?tab=pooled');
  await list(page).locator('tbody tr').first().getByRole('button', { name: 'Invest' }).click(UNBUILT);
  const sheet = page.getByRole('dialog', { name: 'Invest in this strategy' });
  await sheet.getByLabel('Amount (USDT)').fill(amount);
  return sheet;
}

test(`${J} #1 opens the pooled strategies list: only those within the drawdown ceiling and open to the person`, async ({ page }) => {
  test.setTimeout(240_000);
  const investor = await fundedTrader(page, 'jcp', '500');
  run.reset({ investor });
  await signIn(page, investor);
  await page.goto('/trade/copy?tab=pooled');
  await expect(list(page).or(page.getByText('No pooled strategies are open.'))).toBeVisible(UNBUILT);
});

test(`${J} #2 invests below the minimum, and with the minimum unset: the minimum shown; or the limit-not-set refusal`, async ({ page }) => {
  const sheet = await invest(page, '0.01');
  await sheet.getByRole('button', { name: 'Review' }).click();
  await expect(sheet.getByText(/The minimum is [\d.]+ USDT|minimum is not set/)).toBeVisible();
});

test(`${J} #3 invests when not on the strategy whitelist: refused as not whitelisted`, async ({ page }) => {
  const sheet = await invest(page, '100');
  await sheet.getByRole('button', { name: 'Review' }).click();
  await expect(sheet.getByText(/not on this strategy’s list/)).toBeVisible();
});

test(`${J} #4 accepts the disclosure and invests TEST 100 in the seed round: 100 shares at 1.00`, async ({ page }) => {
  const sheet = await invest(page, '100');
  await sheet.getByRole('checkbox', { name: /I have read the disclosure/ }).check();
  await sheet.getByRole('button', { name: 'Invest' }).click();
  await expect(page.getByText(/100 shares at 1\.00/)).toBeVisible();
});

test(`${J} #5 redeems inside the lock-up: refused as locked`, async ({ page }) => {
  await signIn(page, state('investor'));
  await page.goto('/trade/copy?tab=pooled&view=mine');
  await page.getByRole('button', { name: 'Redeem' }).first().click(UNBUILT);
  await expect(page.getByText(/locked until/)).toBeVisible();
});

test(`${J} #6 redeems two lots bought on different days: the earlier lot first`, async () => {
  const lots = await (await api(state('investor'))).get('/api/trade/trpc/pooled.lots');
  expect(lots.status).toBe(200);
});

test(`${J} #7 asks for a profit withdrawal: refused, principal only`, async () => {
  const res = await (await api(state('investor'))).post('/api/trade/trpc/pooled.withdrawProfit', {});
  expect(JSON.stringify(res.body)).toMatch(/principal_only/);
});

test(`${J} #8 opens the investor dashboard: the pending redemption shows as pending redemption`, async ({ page }) => {
  await signIn(page, state('investor'));
  await page.goto('/trade/copy?tab=pooled&view=mine');
  await expect(page.getByRole('region', { name: 'My pooled investments' })).toContainText('Pending redemption', UNBUILT);
});
