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
  await expect(page.getByRole('region', { name: 'Your strategies' }).getByRole('table')).toHaveCount(0);
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

/** The next write to `procedure` reaches the service, but its reply is lost on the way back, as on a dropped line. */
async function loseNextReply(page, procedure) {
  let lost = false;
  await page.route(`**/api/quant/trpc/${procedure}*`, async (route) => {
    if (lost) return route.continue();
    lost = true;
    await route.fetch();
    await route.abort('connectionreset');
  });
}

async function studioRules(page, { name, cash, symbol, qty, drawdown, notional, kill }) {
  await page.getByLabel('Strategy name').fill(name);
  await page.getByLabel('Simulated starting cash').fill(cash);
  await page.getByLabel('Block 1 symbol').fill(symbol);
  await page.getByLabel('Block 1 quantity').fill(qty);
  await page.getByLabel('Max drawdown (service unit unspecified)').fill(drawdown);
  await page.getByLabel('Max notional (service unit unspecified)').fill(notional);
  await page.getByLabel('Kill threshold (service unit unspecified)').fill(kill);
}

test(`${J} #4 saves the strategy at version 1; Save again after a lost reply makes no duplicate, and a change makes one version 2`, async ({
  page,
}) => {
  await signIn(page, developer());
  await page.goto('/quant/studio');
  const library = page.getByRole('region', { name: 'Your strategy library' }).getByRole('table');
  const save = page.getByRole('button', { name: 'Save to library', exact: true });
  const state = page.getByTestId('quant-save-state');
  await expect(page.getByText('No strategy is saved yet.')).toBeVisible();

  // TEST rules: every figure is a simulation input typed by the developer.
  await studioRules(page, {
    name: 'TEST first strategy',
    cash: '1000',
    symbol: 'BTC/USDT',
    qty: '0.01',
    drawdown: '100',
    notional: '500',
    kill: '50',
  });
  await expect(state).toHaveText('Unsaved. Saving keeps the rules in your library on this account.');

  // The first reply is lost: the service saved it, the screen never heard. Pressing Save again returns the same row.
  await loseNextReply(page, 'studio.save');
  await save.click();
  await expect(page.locator('.quant-save .failure')).toBeVisible();
  await save.click();
  await expect(state).toHaveText('Saved as version 1.');
  await expect(save).toBeDisabled();
  await expect(library.getByRole('row')).toHaveCount(2); // the header and one strategy
  await expect(library).toContainText('TEST first strategy');
  await expect(library).toContainText('Version 1');

  // A change, saved with its reply lost and saved again: one version 2, still one strategy.
  await page.getByLabel('Block 1 quantity').fill('0.02');
  await expect(state).toHaveText('Changed since version 1. Save to keep these rules as the next version.');
  await loseNextReply(page, 'studio.update');
  await save.click();
  await expect(page.locator('.quant-save .failure')).toBeVisible();
  await save.click();
  await expect(state).toHaveText('Saved as version 2.');
  await expect(library.getByRole('row')).toHaveCount(2);
  await expect(library).toContainText('Version 2');

  // Unsaved rules are never dropped on one press: starting a new strategy warns first and leaves the form as it is.
  await page.getByLabel('Block 1 quantity').fill('0.03');
  await page.getByRole('button', { name: 'Start a new strategy' }).click();
  await expect(page.getByTestId('quant-replace-warning')).toHaveText('The rules in the form are not saved. Press again to replace them.');
  await expect(page.getByLabel('Block 1 quantity')).toHaveValue('0.03');
  await page.getByLabel('Block 1 quantity').fill('0.02');
  await expect(state).toHaveText('Saved as version 2.');

  // The library holds it after a reload, and the Algo dev home ticks the first quick-start step.
  await page.reload();
  await expect(page.getByLabel('Block 1 quantity')).toHaveValue('0.02');
  await expect(state).toHaveText('Saved as version 2.');
  await page.goto('/quant');
  await expect(page.getByTestId('quant-quick-start-count')).toHaveText('1 of 3 steps done');
  const home = page.getByRole('region', { name: 'Your strategies' }).getByRole('table');
  await expect(home.getByRole('row')).toHaveCount(2);
  await expect(home).toContainText('Version 2');
  run.write({ strategy: 'TEST first strategy' });
});
