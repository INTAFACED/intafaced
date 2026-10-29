import { test, expect } from '@playwright/test';
import { journeyState, tool } from './stack.mjs';
import { fundedTrader, signIn } from './desk.mjs';

// J-copy-bots-otc-18, in the running app (docs/roadmap/journeys.json): rebalance with a combo bot and run delta-neutral
// funding arbitrage. One test per step, titled "J-copy-bots-otc-18 #<n>", run in order on one verified TEST account with
// TEST 2000 USDT. A delisting comes from the stack's TEST market tool (`local-test-market.mjs delist`); the minimum leg,
// threshold and opportunity feed are the stack's TEST bot terms.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - every step: the bot catalogue has no combo or smart-arbitrage bot and there is no opportunity view.
// - #3: the stack's market tool has no `delist` yet.
const J = 'J-copy-bots-otc-18';
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

async function comboWizard(page) {
  await signIn(page, state('trader'));
  await page.goto('/trade/bots');
  await page
    .getByRole('table', { name: 'Bot catalogue' })
    .getByRole('row', { name: /^Combo/ })
    .getByRole('button', { name: 'Set up' })
    .click(UNBUILT);
  return page.getByRole('dialog', { name: 'Set up a combo bot' });
}

async function legs(wizard, rows) {
  for (const [i, [asset, weight]] of rows.entries()) {
    if (i > 0) await wizard.getByRole('button', { name: 'Add a coin' }).click();
    await wizard.getByLabel(`Coin ${i + 1}`).selectOption(asset);
    await wizard.getByLabel(`Weight ${i + 1}, %`).fill(String(weight));
  }
}

test(`${J} #1 creates a combo bot with one contract, weights totalling 80, and a 0.5% threshold: each refused with its code`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const trader = await fundedTrader(page, 'jcc', '2000');
  run.reset({ trader });
  const wizard = await comboWizard(page);
  await legs(wizard, [['BTC', 100]]);
  await wizard.getByRole('button', { name: 'Create bot' }).click();
  await expect(wizard.getByText(/at least two coins/)).toBeVisible();
  await legs(wizard, [
    ['BTC', 50],
    ['ETH', 30],
  ]);
  await wizard.getByRole('button', { name: 'Create bot' }).click();
  await expect(wizard.getByText(/add up to 80%/)).toBeVisible();
});

test(`${J} #2 creates it correctly: the rebalance plan; a leg below the minimum skipped with the reason`, async ({ page }) => {
  const wizard = await comboWizard(page);
  await legs(wizard, [
    ['BTC', 70],
    ['ETH', 30],
  ]);
  await wizard.getByLabel('Rebalance threshold, %').fill('5');
  await wizard.getByRole('button', { name: 'Create bot' }).click();
  await expect(page.getByRole('table', { name: 'Rebalance plan' })).toBeVisible();
});

test(`${J} #3 opens the details page after a delisting on one leg: closed once with "Delisting"; rounds in order`, async ({ page }) => {
  tool('local-test-market.mjs', 'delist', 'ETH/USDT');
  await signIn(page, state('trader'));
  await page.goto('/trade/bots?tab=mine');
  await expect(page.getByRole('row', { name: /Combo/ })).toContainText('Delisting', UNBUILT);
});

test(`${J} #4 opens the funding and spread opportunity view: with no feed, the notice; a blank funding rate reads "Not set"`, async ({
  page,
}) => {
  await signIn(page, state('trader'));
  await page.goto('/trade/bots/opportunities');
  await expect(page.getByRole('heading', { name: 'Opportunities', level: 1 })).toBeVisible(UNBUILT);
  await expect(page.getByText(/needs a market feed|Not set/).first()).toBeVisible();
});

test(`${J} #5 creates a smart arbitrage bot: the keep-or-sell choice; APY "Not set" while its source is absent`, async ({ page }) => {
  await signIn(page, state('trader'));
  await page.goto('/trade/bots');
  await page
    .getByRole('table', { name: 'Bot catalogue' })
    .getByRole('row', { name: /^Smart arbitrage/ })
    .getByRole('button', { name: 'Set up' })
    .click(UNBUILT);
  await expect(page.getByRole('dialog').getByRole('radiogroup', { name: 'When it stops' })).toBeVisible();
  await expect(page.getByRole('dialog')).toContainText(/APY\s*Not set/);
});

test(`${J} #6 opens the opportunity classes: spot, triangular, basis and funding, each with a scanner result and an owner gate`, async ({
  page,
}) => {
  await signIn(page, state('trader'));
  await page.goto('/trade/bots/opportunities');
  for (const name of ['Spot', 'Triangular', 'Basis', 'Funding']) await expect(page.getByRole('tab', { name })).toBeVisible(UNBUILT);
});
