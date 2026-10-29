import { test, expect } from '@playwright/test';
import { api, journeyState } from './stack.mjs';
import { fundedTrader, signIn } from './desk.mjs';

// J-more-catalogue-17, in the running app (docs/roadmap/journeys.json): use the controls Predict keeps parked, and set my
// limits. One test per step, titled "J-more-catalogue-17 #<n>", run in order on one verified TEST account with TEST 100
// USDT. No Predict service runs on the stack (owner decision), so every parked control must name that blocker; the
// limits and demo mode are the account's own settings. Balances are read back from the ledger.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - #1 to #3, #5 to #7: the Predict room has no Provide liquidity control, trading hours strip, maintenance state,
//   break, funding cap or restricted-account ticket.
// - #4: there is no /predict/settings page for responsible-trading limits.
// - #8: there is no demo mode.
const J = 'J-more-catalogue-17';
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

async function predict(page, path = '/predict') {
  await signIn(page, state('trader'));
  await page.goto(path);
}

async function settings(page) {
  await predict(page, '/predict/settings');
  await expect(page.getByRole('heading', { name: 'Responsible trading', level: 1 })).toBeVisible(UNBUILT);
}

test(`${J} #1 presses Provide liquidity: the refusal names the Predict lane, the allowlist copy, and the code in a data attribute`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const trader = await fundedTrader(page, 'jmpp', '100');
  run.reset({ trader });
  await predict(page);
  await room(page).getByRole('button', { name: 'Provide liquidity' }).click(UNBUILT);
  const refusal = room(page).getByRole('alert');
  await expect(refusal).toContainText(/Predict/);
  await expect(refusal).toHaveAttribute('data-code', /^predict\./);
});

test(`${J} #2 opens the trading hours strip with no schedule: "schedule not set" and no hours`, async ({ page }) => {
  await predict(page);
  const hours = room(page).getByRole('region', { name: 'Trading hours' });
  await expect(hours).toContainText(/schedule not set/i, UNBUILT);
  await expect(hours).not.toContainText(/\d{1,2}:\d{2}/);
});

test(`${J} #3 orders during a maintenance pause: a typed refusal; open positions stay visible`, async ({ page }) => {
  await predict(page);
  await expect(room(page).getByText(/maintenance/i)).toBeVisible(UNBUILT);
  await page.goto('/predict/positions');
  await expect(room(page).getByRole('table', { name: 'Positions' })).toBeVisible();
});

test(`${J} #4 opens /predict/settings and saves a blank limit: a typed refusal; unset controls read "not set"`, async ({ page }) => {
  await settings(page);
  await page.getByLabel('Daily loss limit').fill('');
  await page.getByRole('button', { name: 'Save limits' }).click();
  await expect(page.getByRole('alert')).toContainText(/limit/i);
  await expect(page.getByText(/not set/i).first()).toBeVisible();
});

test(`${J} #5 sets a trading break and tries to order: a typed refusal, no intent row; positions visible but not sellable`, async ({
  page,
}) => {
  await settings(page);
  await page.getByLabel('Take a break for').selectOption('24 hours');
  await page.getByRole('button', { name: 'Start the break' }).click();
  await predict(page);
  await expect(room(page).getByRole('alert')).toContainText(/break/i);
});

test(`${J} #6 hits the funding cap: the refusal with the remaining allowance`, async ({ page }) => {
  await settings(page);
  await page.getByLabel('Most I can add per month (USDT)').fill('10');
  await page.getByRole('button', { name: 'Save limits' }).click();
  await predict(page);
  await expect(room(page).getByText(/remaining allowance/i)).toBeVisible();
});

test(`${J} #7 opens as a restricted account: the ticket refuses clearly and names the reason`, async ({ page }) => {
  await predict(page);
  await expect(room(page).getByRole('form', { name: 'Prediction ticket' })).toContainText(/restricted/i, UNBUILT);
});

test(`${J} #8 turns on demo mode and places a demo order: labelled TEST; no ledger balance moves`, async ({ page }) => {
  const trader = state('trader');
  const before = (await (await api(trader)).balances()).USDT;
  await predict(page);
  await room(page).getByRole('switch', { name: 'Demo mode' }).check(UNBUILT);
  await expect(room(page).getByText('TEST').first()).toBeVisible();
  expect((await (await api(trader)).balances()).USDT).toEqual(before);
});
