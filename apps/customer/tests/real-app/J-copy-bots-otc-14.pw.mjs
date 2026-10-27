import { test, expect } from '@playwright/test';
import { api, journeyState, toUnits } from './stack.mjs';

const ONE = toUnits('1');
import { fundedTrader, signIn, signUp } from './desk.mjs';

// J-copy-bots-otc-14, in the running app (docs/roadmap/journeys.json): start a spot grid bot and watch it earn. One test
// per step, titled "J-copy-bots-otc-14 #<n>". The trader is a TEST account on the local stack, verified and funded with
// TEST USDT; the bot's levels go to the real TEST book. The reserve must equal the investment and each level hold only its
// own order, which the steps read from the ledger.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - svc-trade has no grid bot: no wizard, plan, levels, range pause, metrics or withdrawal (CB-bots-02, -05, -10).
// - #1: the Bots hub has no per-type status and no My bots from the server (CB-bots-01).
const J = 'J-copy-bots-otc-14';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const UNBUILT = { timeout: 5_000 };

test.describe.configure({ mode: 'default' });

const wizard = (page) => page.getByRole('form', { name: 'Spot grid' });
const usdt = async () => (await (await api(run.read().who)).balances()).USDT;

async function openBots(page) {
  await signIn(page, run.read().who);
  await page.goto('/bots');
  await expect(page.getByRole('heading', { name: 'Bots', level: 1 })).toBeVisible();
}

async function openGrid(page) {
  await openBots(page);
  await page.getByRole('link', { name: /Spot grid/ }).click();
  await expect(wizard(page)).toBeVisible(UNBUILT);
}

test(`${J} starts: a verified TEST account with 1000 USDT`, async ({ page }) => {
  test.setTimeout(180_000);
  run.reset({ who: await fundedTrader(page, 'gb', '1000') });
});

test(`${J} #1 opens Bots: the hub with one status and one link per bot type, each refusal in words; My bots from the server even in a new browser`, async ({
  page,
}) => {
  await openBots(page);
  const types = page.getByRole('list', { name: 'Bot types' }).getByRole('listitem');
  await expect(types.first()).toBeVisible(UNBUILT);
  for (const type of await types.all()) {
    await expect(type.getByRole('link')).toHaveCount(1);
    await expect(type.getByTestId('bot-type-status')).toHaveText(/Available|Not available: .+/);
  }
  await expect(page.getByRole('region', { name: 'My bots' })).toBeVisible();
});

test(`${J} #2 opens the grid wizard below the owner's verification level: refused as verification insufficient, and no bot written`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  const unverified = await signUp(page, 'gu');
  await signIn(page, unverified);
  await page.goto('/bots');
  await page.getByRole('link', { name: /Spot grid/ }).click(UNBUILT);
  await expect(page.getByRole('alert')).toContainText(/verification level/);
  await expect(wizard(page).getByRole('button', { name: 'Create bot' })).toHaveCount(0);
});

test(`${J} #3 opens presets: with no backtest source the list reads "Not set" and no APR`, async ({ page }) => {
  await openGrid(page);
  await wizard(page).getByRole('tab', { name: 'Presets' }).click();
  await expect(page.getByRole('tabpanel', { name: 'Presets' })).toContainText('Not set');
  await expect(page.getByRole('tabpanel', { name: 'Presets' })).not.toContainText(/APR\s*[\d.]+/);
});

test(`${J} #4 enters bounds left blank, then one grid, then twenty: the first two refused naming the field; twenty levels planned; a second create with the same key returns the same bot`, async ({
  page,
}) => {
  const before = await usdt();
  await openGrid(page);
  const field = (name) => wizard(page).getByRole('textbox', { name });
  await field('Investment, USDT').fill('200');
  await field('Grids').fill('20');
  await wizard(page).getByRole('button', { name: 'Create bot' }).click();
  await expect(wizard(page).getByRole('alert')).toContainText('Lower price');
  const bid = toUnits(((await page.getByTestId('grid-last-price').textContent()) ?? '').replace(/[^\d.]/g, ''));
  // Whole numbers 10% under and over the last price, in bigint units.
  await field('Lower price').fill(String((bid * 9n) / 10n / ONE));
  await field('Upper price').fill(String((bid * 11n) / 10n / ONE + 1n));
  await field('Grids').fill('1');
  await wizard(page).getByRole('button', { name: 'Create bot' }).click();
  await expect(wizard(page).getByRole('alert')).toContainText('Grids');
  await field('Grids').fill('20');
  await expect(wizard(page).getByTestId('grid-plan').getByRole('listitem')).toHaveCount(20);
  await wizard(page).getByRole('button', { name: 'Create bot' }).click();
  await expect(page.getByRole('status')).toContainText('Bot running');
  // The reserve is the investment; nothing more is held.
  expect(toUnits((await usdt()).used) - toUnits(before.used)).toBe(toUnits('200'));
});

test(`${J} #5 lets the price leave the upper bound: no new buy is placed and the range pause shows`, async ({ page }) => {
  await openBots(page);
  const bot = page.getByRole('region', { name: 'My bots' }).getByRole('row').filter({ hasText: 'Spot grid' }).first();
  await expect(bot).toBeVisible(UNBUILT);
  await expect(bot).toContainText(/Running|Paused: the price is outside the range/);
});

test(`${J} #6 opens Metrics after two closed level pairs: grid profit is their sum net of fees; an APR with zero days reads "Not set"`, async ({
  page,
}) => {
  await openBots(page);
  await page
    .getByRole('region', { name: 'My bots' })
    .getByRole('link', { name: /Spot grid/ })
    .first()
    .click(UNBUILT);
  await page.getByRole('tab', { name: 'Metrics' }).click();
  const metrics = page.getByRole('tabpanel', { name: 'Metrics' });
  await expect(metrics).toContainText(/Grid profit\s*-?[\d.]+ USDT/);
  await expect(metrics).toContainText(/APR\s*(Not set|-?[\d.]+ ?%)/);
});

test(`${J} #7 withdraws over the cap, then within it without a step-up: both refused; within both, it succeeds with a receipt`, async ({
  page,
}) => {
  await openBots(page);
  await page
    .getByRole('region', { name: 'My bots' })
    .getByRole('link', { name: /Spot grid/ })
    .first()
    .click(UNBUILT);
  await page.getByRole('button', { name: 'Withdraw profit' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'Amount, USDT' }).fill('1000000');
  await dialog.getByRole('button', { name: 'Withdraw' }).click();
  await expect(dialog.getByRole('alert')).toContainText(/more than you can withdraw/);
});
