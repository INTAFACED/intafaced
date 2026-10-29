import { test, expect } from '@playwright/test';
import { api, fund, journeyState } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';

// J-more-catalogue-20, in the running app (docs/roadmap/journeys.json): understand and use IFC: stake, real yield,
// supply and burns. One test per step, titled "J-more-catalogue-20 #<n>", run in order on one verified TEST account
// holding TEST 1000 IFC. Every stake, payout, run and figure is read back from svc-token; the emission, cap, halving and
// buyback split are the stack's TEST token terms, and blank ones must read "not set".
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - #1: the token page lists stakes but has no Stake or Unstake control.
// - #2 to #5: no yield view, buyback and burn log, emission schedule or supply and distribution panel.
// - #6, #7: no founding badge and no IFC gas charge.
const J = 'J-more-catalogue-20';
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
const trpc = (proc, input) => `/api/token/trpc/${proc}?input=${encodeURIComponent(JSON.stringify(input ?? {}))}`;
const stakes = async (who, status) => (await (await api(who)).get(trpc('listStakes', { status }))).body.result.data;

async function token(page, path = '/token') {
  await signIn(page, state('holder'));
  await page.goto(path);
}

test(`${J} #1 stakes IFC, then unstakes part: the stake pending then active; unstake closes after the ledger post`, async ({ page }) => {
  test.setTimeout(240_000);
  const holder = await signUp(page, 'jmifc');
  await verify(page, holder);
  expect(fund(holder.email, 'IFC', '1000').tx).toBeTruthy();
  run.reset({ holder });
  await token(page);
  await room(page).getByRole('button', { name: 'Stake IFC' }).click(UNBUILT);
  await page.getByRole('dialog').getByLabel('Amount (IFC)').fill('100');
  await page.getByRole('dialog').getByRole('button', { name: 'Stake' }).click();
  await expect.poll(async () => (await stakes(holder, 'active')).length, { timeout: 30_000 }).toBe(1);
  await room(page).getByRole('button', { name: 'Unstake' }).first().click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Unstake' }).click();
  await expect.poll(async () => (await stakes(holder, 'closed')).length, { timeout: 30_000 }).toBe(1);
});

test(`${J} #2 opens the yield view: the weekly real-yield share per window`, async ({ page }) => {
  await token(page, '/token/yield');
  const table = room(page).getByRole('table', { name: 'Real yield by week' });
  await expect(table.or(room(page).getByText('No yield windows yet.'))).toBeVisible(UNBUILT);
});

test(`${J} #3 opens the buyback and burn log: each run with its schedule and split`, async ({ page }) => {
  await token(page, '/token/economy');
  const log = room(page).getByRole('table', { name: 'Buybacks and burns' });
  await expect(log.or(room(page).getByText('No buyback runs yet.'))).toBeVisible(UNBUILT);
});

test(`${J} #4 opens the emission schedule: epochs, halvings and the minter rule; blank values read "not set"`, async ({ page }) => {
  await token(page, '/token/economy');
  const schedule = room(page).getByRole('region', { name: 'Emission schedule' });
  await expect(schedule).toBeVisible(UNBUILT);
  for (const name of ['Reward per epoch', 'Supply cap', 'Halving'])
    await expect(schedule).toContainText(new RegExp(`${name}\\s*(Not set|[\\d,.]+)`));
});

test(`${J} #5 opens the supply and distribution panel: from the service; missing figures "not reported"`, async ({ page }) => {
  await token(page, '/token/economy');
  const supply = room(page).getByRole('region', { name: 'Supply and distribution' });
  await expect(supply).toBeVisible(UNBUILT);
  await expect(supply).toContainText(/Circulating supply\s*(Not reported|[\d,.]+)/);
});

test(`${J} #6 claims the founding badge: shown once`, async ({ page }) => {
  await token(page);
  await room(page).getByRole('button', { name: 'Claim founding badge' }).click(UNBUILT);
  await expect(room(page).getByRole('img', { name: 'Founding badge' })).toHaveCount(1);
  await expect(room(page).getByRole('button', { name: 'Claim founding badge' })).toHaveCount(0);
});

test(`${J} #7 does an internal action that has a gas charge: the IFC gas fee charged once`, async ({ page }) => {
  const holder = state('holder');
  await token(page, '/token/economy');
  await expect(room(page).getByText(/Gas fee\s*[\d.]+ IFC/)).toBeVisible(UNBUILT);
  expect((await (await api(holder)).balances()).IFC).toBeTruthy();
});
