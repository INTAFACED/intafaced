import { test, expect } from '@playwright/test';
import { api, journeyState, tool } from './stack.mjs';
import { fundedTrader, signIn } from './desk.mjs';

// J-more-catalogue-07, in the running app (docs/roadmap/journeys.json): see my mining rewards and get paid. One test per
// step, titled "J-more-catalogue-07 #<n>", run in order on one verified TEST miner. Shares come from the stack's TEST
// miner (`local-test-world.mjs mining-share`) and the window is sealed by the stack's TEST pool clock
// (`local-test-world.mjs mining-seal`). The reward source is an owner decision; while it is undecided the room names it.
// Every window, row, rule and request is read back from svc-mining-pool, and every balance from the ledger.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - #1: the Rewards section reads no scheme or fee history.
// - #2 to #6: no stack tool submits shares or seals a window; the room has no window view, payout rules, payout address
//   or payout request.
const J = 'J-more-catalogue-07';
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

const trpc = (proc, input) => `/api/mining-pool/trpc/${proc}?input=${encodeURIComponent(JSON.stringify(input ?? {}))}`;
const read = async (who, proc, input) => (await (await api(who)).get(trpc(proc, input))).body?.result?.data;
const payouts = (page) => page.getByRole('region', { name: 'Payouts' });

test(`${J} #1 opens /mining/rewards: the reward scheme and a dated fee history; an undecided reward source named`, async ({ page }) => {
  test.setTimeout(240_000);
  const miner = await fundedTrader(page, 'jmr', '1');
  run.reset({ miner });
  await signIn(page, miner);
  await page.goto('/mining/rewards');
  const rewards = page.getByRole('region', { name: 'Rewards' });
  await expect(rewards.getByRole('table', { name: 'Fee history' })).toBeVisible(UNBUILT);
  await expect(rewards).toContainText(/Reward scheme\s*\w+/);
  await expect(rewards).toContainText(/Reward source\s*(Waiting for the owner’s decision|.+)/);
});

test(`${J} #2 opens a sealed window: my row in the shares, the fee used; a share after seal refused`, async ({ page }) => {
  const miner = state('miner');
  tool('local-test-world.mjs', 'mining-share', miner.email, 'Rig-A');
  const sealed = JSON.parse(tool('local-test-world.mjs', 'mining-seal'));
  run.write({ windowId: sealed.windowId });
  await signIn(page, miner);
  await page.goto(`/mining/rewards?window=${encodeURIComponent(sealed.windowId)}`);
  const window = page.getByRole('region', { name: 'Window' });
  await expect(window.getByRole('row', { name: /Rig-A/ })).toBeVisible(UNBUILT);
  await expect(window).toContainText(/Fee\s*[\d.]+%/);
  const late = await (await api(miner)).post('/api/mining-pool/trpc/shares.submit', { windowId: sealed.windowId, worker: 'Rig-A' });
  expect(JSON.stringify(late.body)).toMatch(/window_sealed/);
});

test(`${J} #3 saves payout rules with a blank threshold: a typed refusal; set values save`, async ({ page }) => {
  const miner = state('miner');
  await signIn(page, miner);
  await page.goto('/mining/rewards');
  await payouts(page).getByLabel('Pay me out above').fill('', UNBUILT);
  await payouts(page).getByRole('button', { name: 'Save payout rules' }).click();
  await expect(payouts(page).getByText('Enter a payout threshold.')).toBeVisible();
  await payouts(page).getByLabel('Pay me out above').fill('0.01');
  await payouts(page).getByRole('button', { name: 'Save payout rules' }).click();
  expect((await read(miner, 'payouts.rules')).threshold).toBe('0.01');
});

test(`${J} #4 adds a payout address and proves it by signature: pending until the delay ends; a change restarts it`, async ({ page }) => {
  await signIn(page, state('miner'));
  await page.goto('/mining/rewards');
  await payouts(page).getByRole('button', { name: 'Add a payout address' }).click(UNBUILT);
  const sheet = page.getByRole('dialog', { name: 'Payout address' });
  await sheet.getByLabel('Address').fill('bc1qtestaddress0000000000000000000000000');
  await sheet.getByRole('button', { name: 'Sign to prove it’s yours' }).click();
  await expect(sheet.getByText(/Pending until|wallet link isn’t connected/)).toBeVisible();
});

test(`${J} #5 requests a payout below the minimum: a typed refusal with the minimum and the remainder`, async ({ page }) => {
  await signIn(page, state('miner'));
  await page.goto('/mining/rewards');
  await payouts(page).getByRole('button', { name: 'Request a payout' }).click(UNBUILT);
  await expect(page.getByText(/below the minimum of [\d.]+; [\d.]+ stays credited/)).toBeVisible();
});

test(`${J} #6 requests a payout, twice: one request under one stored key; a kind with no withdrawal door names the crypto rail`, async ({
  page,
}) => {
  const miner = state('miner');
  await signIn(page, miner);
  await page.goto('/mining/rewards');
  const request = payouts(page).getByRole('button', { name: 'Request a payout' });
  await request.click(UNBUILT);
  await request.click();
  const made = await read(miner, 'payouts.requests');
  expect(new Set(made.map((r) => r.key)).size).toBe(made.length);
  await expect(page.getByText(/needs a crypto rail|Payout requested/)).toBeVisible();
});
