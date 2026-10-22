import { test, expect } from '@playwright/test';
import { journeyState } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';

// J-algo-dev-01, in the running app (docs/roadmap/journeys.json): build a first strategy, save it and backtest it on
// history. One test per step this build serves, titled "J-algo-dev-01 #<n>", run in order on one TEST developer who
// starts signed in, verified and with no strategy. Every figure in Algo dev is simulated; nothing here moves money.
const J = 'J-algo-dev-01';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });

function developer() {
  const who = run.read().account;
  if (!who) throw new Error(`${J} #1 made no account, so this step has no one to act as`);
  return who;
}

const ROOMS = ['Start', 'Studio', 'Backtest', 'Sandbox', 'Execution'];

test(`${J} #1 opens Algo dev from the Trade menu: every room listed, quick start at zero of three, no strategy saved`, async ({ page }) => {
  const who = await signUp(page, 'ja');
  await verify(page, who);
  run.reset({ account: who });
  await signIn(page, developer());

  // The Trade menu opens on hover; Algo dev sits in its list (under Advanced in Simple mode).
  await page.goto('/home');
  await page.locator('.tb-tab', { hasText: 'Trade' }).hover();
  await page
    .locator('.tb-menu')
    .getByRole('link', { name: /Algo dev/ })
    .click();
  await expect(page).toHaveURL(/\/quant$/);
  await expect(page.getByRole('heading', { name: 'Algo dev', level: 1 })).toBeVisible();

  // Every room is listed, none hidden, and each one opens.
  const rooms = page.getByRole('navigation', { name: 'Algo dev rooms' });
  for (const name of ROOMS) await expect(rooms.getByRole('link', { name })).toBeVisible();
  await expect(rooms.getByRole('link', { name: 'Start' })).toHaveAttribute('aria-current', 'page');

  // The quick start is ticked from this account's own rows: nothing yet, and no sample strategy anywhere.
  await expect(page.getByTestId('quant-quick-start-count')).toHaveText('0 of 3 steps done');
  await expect(page.locator('.quant-quick-start li[data-done=true]')).toHaveCount(0);
  await expect(page.getByText('No strategy is saved yet.')).toBeVisible();
  await expect(page.getByRole('table', { name: 'Your strategies' })).toHaveCount(0);
  await expect(page.getByText('Simulated only.')).toBeVisible();

  // Each room in the list opens its own page.
  for (const [name, path] of [
    ['Studio', /\/quant\/studio$/],
    ['Backtest', /\/quant\/backtest$/],
    ['Sandbox', /\/quant\/sandbox$/],
  ]) {
    await page.goto('/quant');
    await page.getByRole('navigation', { name: 'Algo dev rooms' }).getByRole('link', { name }).click();
    await expect(page).toHaveURL(path);
    await expect(page.getByRole('navigation', { name: 'Algo dev rooms' }).getByRole('link', { name })).toHaveAttribute(
      'aria-current',
      'page',
    );
  }
});
