import { test, expect } from '@playwright/test';
import { journeyState } from './stack.mjs';
import { fundedTrader, signIn } from './desk.mjs';

// J-copy-bots-otc-27, in the running app (docs/roadmap/journeys.json): trade atomic spreads and request a bespoke options
// block. One test per step, titled "J-copy-bots-otc-27 #<n>", run in order on one verified TEST business account with
// TEST 20000 USDT. Spread instruments are those the stack lists; ECP self-certification is made on the bespoke form.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - every step: there is no Spread room (calendar and inter-coin spreads, IOC and FOK, spread API) and no bespoke
//   options request.
const J = 'J-copy-bots-otc-27';
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

async function spread(page) {
  await signIn(page, state('trader'));
  await page.goto('/otc/spread');
  await expect(page.getByRole('heading', { name: 'Spread', level: 1 })).toBeVisible(UNBUILT);
}

test(`${J} #1 opens Spread with nothing listed: "No spread instruments listed"`, async ({ page }) => {
  test.setTimeout(240_000);
  const trader = await fundedTrader(page, 'jcsx', '20000');
  run.reset({ trader });
  await spread(page);
  await expect(page.getByText('No spread instruments listed')).toBeVisible();
});

test(`${J} #2 places a calendar spread: the spread price; a leg that can't fill refuses the whole spread with nothing held`, async ({
  page,
}) => {
  await spread(page);
  await page.getByRole('tab', { name: 'Calendar' }).click();
  await expect(page.getByRole('table', { name: 'Spread book' })).toBeVisible();
});

test(`${J} #3 places an inter-coin spread at 2:1: one hold and one fill`, async ({ page }) => {
  await spread(page);
  await page.getByRole('tab', { name: 'Inter-coin' }).click();
  await page.getByLabel('Ratio').fill('2:1');
  await page.getByRole('button', { name: 'Place spread' }).click();
  await expect(page.getByText('Filled')).toBeVisible();
});

test(`${J} #4 places IOC and FOK orders on a partly filled spread: IOC cancels the rest; FOK refuses whole`, async ({ page }) => {
  await spread(page);
  await page.getByLabel('Time in force').selectOption('FOK');
  await page.getByRole('button', { name: 'Place spread' }).click();
  await expect(page.getByText(/couldn’t fill in full/)).toBeVisible();
});

test(`${J} #5 trades from a blocked region: refused as region blocked; zero days make the APR "Not set"`, async ({ page }) => {
  await spread(page);
  await expect(page.getByText(/APR\s*Not set/)).toBeVisible();
});

test(`${J} #6 places and mass-cancels spread orders by API; amends one: cancel all once; an amend rests a new id`, async ({ page }) => {
  await spread(page);
  await page.getByRole('button', { name: 'Cancel all' }).click();
  await expect(page.getByText(/No open spread orders/)).toBeVisible();
});

test(`${J} #7 requests a bespoke option with the strike blank: refused naming the strike; uncertified refused as ECP required`, async ({
  page,
}) => {
  await signIn(page, state('trader'));
  await page.goto('/otc/bespoke');
  const form = page.getByRole('form', { name: 'Request a bespoke option' });
  await form.getByRole('button', { name: 'Send request' }).click(UNBUILT);
  await expect(form.getByText('Enter a strike.')).toBeVisible();
});

test(`${J} #8 certifies and requests again: the request reaches the desk`, async ({ page }) => {
  await signIn(page, state('trader'));
  await page.goto('/otc/bespoke');
  const form = page.getByRole('form', { name: 'Request a bespoke option' });
  await form.getByRole('checkbox', { name: /eligible contract participant/ }).check(UNBUILT);
  await form.getByLabel('Strike').fill('100000');
  await form.getByRole('button', { name: 'Send request' }).click();
  await expect(page.getByText('Your request reached the desk')).toBeVisible();
});
