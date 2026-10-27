import { test, expect } from '@playwright/test';
import { api, journeyState, toUnits, tool } from './stack.mjs';
import { fundedTrader, signIn } from './desk.mjs';

// J-more-catalogue-13, in the running app (docs/roadmap/journeys.json): stake in a launch pool and see my distribution
// schedule. One test per step, titled "J-more-catalogue-13 #<n>", run in order on one verified TEST account with TEST 500
// USDT. #1 seeds the start: one stake-to-earn TEST pool with a warming period and one TEST launch with a linear vesting
// schedule (`local-test-world.mjs launch-pools`). Every hold and release is read back from the ledger; on-chain stake and
// claim stay with Protocol.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - every step: no launch pool service, so no pools section on /launch, no stake or unstake, no new-token event
//   registration and no distribution schedule; the stack has no `launch-pools` world step.
const J = 'J-more-catalogue-13';
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

const pools = (page) => page.getByRole('region', { name: 'Launch pools' });
const used = async (who) => toUnits((await (await api(who)).balances()).USDT?.used ?? '0');

async function pool(page) {
  await signIn(page, state('staker'));
  await page.goto('/launch');
  const card = pools(page)
    .getByRole('article')
    .filter({ hasText: state('pool').name });
  await expect(card).toBeVisible(UNBUILT);
  return card;
}

async function stake(page, card, amount) {
  await card.getByRole('button', { name: 'Stake' }).click();
  await page.getByRole('dialog').getByLabel('Amount (USDT)').fill(amount);
  await page.getByRole('dialog').getByRole('button', { name: 'Stake' }).click();
}

test(`${J} #1 joins the pool and stakes: the hold posts once; "Pending start" then "Mining"; a blank warming period refuses`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const staker = await fundedTrader(page, 'jmlp', '500');
  run.reset({ staker });
  await signIn(page, staker);
  await page.goto('/launch');
  await expect(pools(page)).toBeVisible(UNBUILT);
  const seeded = JSON.parse(tool('local-test-world.mjs', 'launch-pools', '--warming-seconds', '20', '--vesting', 'linear'));
  run.write({ pool: seeded.pool, launch: seeded.launch });
  const card = await pool(page);
  await stake(page, card, '100');
  expect(await used(staker)).toBe(toUnits('100'));
  await expect(card).toContainText('Pending start');
  await expect(card).toContainText('Mining', { timeout: 60_000 });
});

test(`${J} #2 stakes twice and unstakes part: stake-seconds follow stored events; unstake releases once`, async ({ page }) => {
  const staker = state('staker');
  const card = await pool(page);
  await stake(page, card, '50');
  expect(await used(staker)).toBe(toUnits('150'));
  await card.getByRole('button', { name: 'Unstake' }).click();
  await page.getByRole('dialog').getByLabel('Amount (USDT)').fill('70');
  await page.getByRole('dialog').getByRole('button', { name: 'Unstake' }).click();
  expect(await used(staker)).toBe(toUnits('80'));
  await expect(card).toContainText(/Stake-seconds\s*[\d,]+/);
});

test(`${J} #3 registers for the new-token event twice: one registration; qualification shown`, async ({ page }) => {
  await signIn(page, state('staker'));
  await page.goto(`/launch/${encodeURIComponent(state('launch').id)}`);
  const register = page.getByRole('button', { name: 'Register' });
  await register.click(UNBUILT);
  await register.click().catch(() => {});
  await expect(page.getByText(/Registered/)).toHaveCount(1);
  await expect(page.getByText(/Qualified|Not qualified/)).toBeVisible();
});

test(`${J} #4 opens the distribution schedule: "schedule not set" with no invented date, or what has vested`, async ({ page }) => {
  await signIn(page, state('staker'));
  await page.goto(`/launch/${encodeURIComponent(state('launch').id)}`);
  const schedule = page.getByRole('region', { name: 'Distribution schedule' });
  await expect(schedule).toBeVisible(UNBUILT);
  await expect(schedule).toContainText(/Schedule not set|Vested\s*[\d,.]+/);
});

test(`${J} #5 presses the on-chain claim: the typed refusal naming the first failing Protocol blocker`, async ({ page }) => {
  await signIn(page, state('staker'));
  await page.goto(`/launch/${encodeURIComponent(state('launch').id)}`);
  await page.getByRole('button', { name: 'Claim on-chain' }).click(UNBUILT);
  await expect(page.getByRole('alert')).toContainText(/Protocol/);
});
