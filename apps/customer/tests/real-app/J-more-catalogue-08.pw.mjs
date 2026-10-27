import { test, expect } from '@playwright/test';
import { ADMIN, founderSignIn } from './admin.mjs';
import { journeyState, tool } from './stack.mjs';
import { fundedTrader } from './desk.mjs';

// J-more-catalogue-08, in the running app (docs/roadmap/journeys.json): a finance operator seals, plans and pays a mining
// window on the console's /more-ops/mining. One test per step, titled "J-more-catalogue-08 #<n>", run in order. #1 makes
// the start: three verified TEST miners submit shares in the ratio 50, 30, 20 through the stack's TEST miner
// (`local-test-world.mjs mining-share`). The reward source is an owner decision; while it is undecided the plan names it.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - #1: no stack tool submits TEST shares (`local-test-world.mjs mining-share`); the console's mining desk reads pool
//   terms, payout windows, shares by window and workers, but no per-worker hashrate samples or daily payout runs.
// - #2 to #4: the desk has no seal, plan, credit or retry action (its payout job refuses until emission is published);
//   no failure tool for a mid-run retry.
const J = 'J-more-catalogue-08';
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

async function desk(page) {
  await founderSignIn(page, 'a');
  await page.goto(`${ADMIN}/more-ops/mining`);
  // The desk's reads (Pool terms, Payout windows, Shares by window, Workers) each carry a read-<id> test id.
  const shares = page.getByTestId('read-mining.shares');
  await expect(shares).toBeVisible();
  return shares;
}

const windowRow = (page) => page.getByTestId('read-mining.windows').getByRole('row', { name: new RegExp(state('windowId')) });

test(`${J} #1 opens the desk: mining shares, per-worker hashrate samples and daily payout runs`, async ({ page, browser }) => {
  test.setTimeout(300_000);
  const miners = [];
  for (const [prefix, weight] of [
    ['jmw1', 5],
    ['jmw2', 3],
    ['jmw3', 2],
  ]) {
    const miner = await fundedTrader(page, prefix, '1');
    for (let i = 0; i < weight; i++) tool('local-test-world.mjs', 'mining-share', miner.email, 'Rig-A');
    miners.push(miner);
  }
  run.reset({ miners });
  const founder = await (await browser.newContext()).newPage();
  const shares = await desk(founder);
  await expect(
    shares
      .getByRole('row')
      .filter({ hasText: /\b10\b/ })
      .first(),
  ).toBeVisible();
  await expect(founder.getByRole('region', { name: 'Hashrate samples' })).toBeVisible(UNBUILT);
  await expect(founder.getByRole('region', { name: 'Payout runs' })).toBeVisible();
  await founder.context().close();
});

test(`${J} #2 seals a window: sealed with its fee; a share after seal refused`, async ({ page }) => {
  await desk(page);
  await page.getByRole('button', { name: 'Seal the open window' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Seal' }).click();
  const sealed = page
    .getByTestId('read-mining.windows')
    .getByRole('row', { name: /Sealed/ })
    .first();
  await expect(sealed).toContainText(/Fee\s*[\d.]+%|[\d.]+%/);
  run.write({ windowId: (await sealed.getByRole('cell').first().innerText()).trim() });
  const late = tool('local-test-world.mjs', 'mining-share', state('miners')[0].email, 'Rig-A', '--window', state('windowId'));
  expect(late).toMatch(/window_sealed/);
});

test(`${J} #3 plans and credits the window: rows per miner before any post; an undecided reward source refused by name`, async ({
  page,
}) => {
  await desk(page);
  await windowRow(page).getByRole('button', { name: 'Plan' }).click();
  const plan = page.getByRole('table', { name: 'Planned rows' });
  await expect(plan.or(page.getByText(/reward source is waiting for the owner’s decision/))).toBeVisible();
  if (await plan.isVisible()) {
    for (const miner of state('miners')) await expect(plan.getByRole('row', { name: new RegExp(miner.handle) })).toContainText('Planned');
  }
});

test(`${J} #4 retries after a failure mid-run: only the stored unpaid row posts`, async ({ page }) => {
  tool('local-test-gates.mjs', 'fail-cancel', 'mining-credit', '--after', '2');
  await desk(page);
  await windowRow(page).getByRole('button', { name: 'Credit' }).click();
  await expect(windowRow(page)).toContainText('Part paid');
  await windowRow(page).getByRole('button', { name: 'Retry' }).click();
  await expect(windowRow(page)).toContainText('Paid');
  await expect(page.getByRole('table', { name: 'Planned rows' }).getByRole('row', { name: /Posted/ })).toHaveCount(3);
});
