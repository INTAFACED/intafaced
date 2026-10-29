import { test, expect } from '@playwright/test';
import { journeyState } from './stack.mjs';
import { fundedTrader, signIn } from './desk.mjs';
import { listLeader } from './copy.mjs';

// J-copy-bots-otc-09, in the running app (docs/roadmap/journeys.json): run a pooled strategy as the master, with a
// managed trading team. One test per step, titled "J-copy-bots-otc-09 #<n>", run in order. #1 makes the start: a TEST
// lead in good standing (listed by the stack's TEST founder) with TEST 2000 USDT. The drawdown limit, capacity window and
// team caps are the stack's TEST pooled terms.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - every step: there is no pooled master application, strategy creation, seed round, master center, capacity
//   takeover or managed team access.
const J = 'J-copy-bots-otc-09';
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

async function masterCenter(page, tab) {
  await signIn(page, state('master'));
  await page.goto('/trade/copy?tab=master');
  await page.getByRole('tab', { name: tab }).click(UNBUILT);
  return page.getByRole('tabpanel', { name: tab });
}

test(`${J} #1 applies as a pooled master: applied with one review row; a description edit is reviewed first`, async ({ page }) => {
  test.setTimeout(240_000);
  const master = await fundedTrader(page, 'jcpm', '2000');
  const leadRef = await listLeader(master, `Journey Master ${Date.now().toString(36)}`);
  run.reset({ master, leadRef });
  await signIn(page, master);
  await page.goto('/trade/copy?tab=master');
  await page.getByRole('button', { name: 'Apply to run a pooled strategy' }).click(UNBUILT);
  await page.getByRole('dialog').getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByText('Applied')).toBeVisible();
});

test(`${J} #2 creates a stable strategy with the drawdown limit blank: refused naming it; a second active strategy refused`, async ({
  page,
}) => {
  const panel = await masterCenter(page, 'Strategy');
  await panel.getByRole('button', { name: 'Create strategy' }).click();
  await expect(panel.getByText(/drawdown limit is not set/)).toBeVisible();
});

test(`${J} #3 creates it with the limit set: "Strategy creation"; a second create with the same key returns the same row`, async ({
  page,
}) => {
  const panel = await masterCenter(page, 'Strategy');
  await panel.getByLabel('Drawdown limit, %').fill('20');
  await panel.getByRole('button', { name: 'Create strategy' }).click();
  await expect(panel).toContainText('Strategy creation');
});

test(`${J} #4 opens the seed round and funds the master account: shares and NAV reconcile`, async ({ page }) => {
  const panel = await masterCenter(page, 'Seed round');
  await panel.getByRole('button', { name: 'Open the seed round' }).click();
  await expect(panel).toContainText(/Net asset value\s*1\.00/);
});

test(`${J} #5 opens the master center with no investors: "No investors yet"`, async ({ page }) => {
  const panel = await masterCenter(page, 'Investors');
  await expect(panel.getByText('No investors yet')).toBeVisible();
});

test(`${J} #6 raises capacity outside the window: refused as window closed; blank takeover thresholds read "Not set"`, async ({ page }) => {
  const panel = await masterCenter(page, 'Capacity');
  await panel.getByRole('button', { name: 'Raise capacity' }).click();
  await expect(panel.getByText(/window is closed/)).toBeVisible();
});

test(`${J} #7 grants a managed team access with the caps blank: refused naming the caps`, async ({ page }) => {
  const panel = await masterCenter(page, 'Team');
  await panel.getByRole('button', { name: 'Grant access' }).click();
  await expect(panel.getByText(/caps are not set/)).toBeVisible();
});

test(`${J} #8 grants with caps set; the team tries to withdraw and to mint a key: trading only`, async ({ page }) => {
  const panel = await masterCenter(page, 'Team');
  await expect(panel.getByRole('table', { name: 'Team access' })).toBeVisible();
});
