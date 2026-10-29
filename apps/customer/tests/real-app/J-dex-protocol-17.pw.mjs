import { test, expect } from '@playwright/test';
import { TOKEN_A, TOKEN_B, UNBUILT, connectWallet, dexRun } from './dex.mjs';
import { fundedTrader, signIn } from './desk.mjs';
import { fund, toUnits } from './stack.mjs';
import { bodyRows, tableIn } from './tables.mjs';

// J-dex-protocol-17, in the running app (docs/roadmap/journeys.json): see what I pay, what I get back, and stake IFC to
// vote. One test per step, titled "J-dex-protocol-17 #<n>", run in order on one verified TEST account holding TEST IFC
// and USDT, with a TEST wallet for the swap quotes. IFC staking, fees and burns are custodial-plane operations through
// the existing ledger recipes; a fee share is paid once under a business key. owner.decision shows while a schedule,
// plan, ladder, buyback rate or rebate programme is unpublished.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - /fees shows the spot schedule (pair groups, maker and taker, the network fee line) but no volume tiers, staking
//   discounts, stable-pair rule or gasless fee display (D-fees-governance-01);
// - /dex has no swap quote with a fee line or integrator fees (D-swap-06, D-fees-governance-03);
// - there is no maker rebate or futures cost breakdown (D-fees-governance-02), no referral code (D-fees-governance-03),
//   no IFC stake plans (RC-dex-protocol-20) or governance staking and delegation (D-fees-governance-05);
// - #3's sub-account clause has no sub-account the app can make yet.
const J = 'J-dex-protocol-17';
const dex = dexRun(`${J}-wallet`);
const account = dexRun(J);

test.describe.configure({ mode: 'default' });

const main = (page) => page.getByRole('main');

/** The run's TEST account, signed in. */
async function person(page) {
  const who = account.run.read().who;
  expect(who, 'the start step made the account').toBeTruthy();
  await signIn(page, who);
  return who;
}

/** The one decimal amount on a line such as "Platform fee 0.0123 TEST Token B"; a line with none or several fails by name. */
function amount(text) {
  const found = text.match(/\d[\d,]*(?:\.\d+)?/g) ?? [];
  expect(found, `one amount in "${text}"`).toHaveLength(1);
  return toUnits(found[0].replaceAll(',', ''));
}

/** The number of decimals a shown amount carries, so an exact sum can be rounded the way the page rounds it. */
const shownDecimals = (text) => text.match(/\d[\d,]*\.(\d+)/)?.[1].length ?? 0;

test(`${J} starts: a verified TEST account with trading history and some TEST IFC`, async ({ page }) => {
  test.setTimeout(240_000);
  const who = await fundedTrader(page, 'dex17', '100');
  expect(fund(who.email, 'IFC', '50').tx).toBeTruthy();
  account.run.reset({ who });
  dex.start();
});

test(`${J} #1 opens the fee schedule: volume tiers, staking discounts, the stable-pair rule and the gasless fee display; with the schedule blank "fee schedule not set"`, async ({
  page,
}) => {
  await person(page);
  await page.goto('/fees');
  await expect(main(page).getByRole('heading', { name: 'Trading fees', level: 1 })).toBeVisible();
  for (const region of ['Volume tiers', 'Staking discounts', 'Stable pairs', 'Gasless swaps'])
    await expect(main(page).getByRole('region', { name: region })).toBeVisible(UNBUILT);
  await expect(tableIn(main(page), 'Volume tiers').getByRole('columnheader', { name: '30-day volume' })).toBeVisible();
});

test(`${J} #2 quotes a stable pair swap: the stable rule applies and the total equals LP fee plus platform fee exactly`, async ({
  page,
}) => {
  await connectWallet(page, dex, { tokens: [TOKEN_A, TOKEN_B] });
  await page.goto('/dex');
  const swap = page.getByRole('form', { name: 'Swap' });
  await swap.getByRole('combobox', { name: 'You pay' }).selectOption({ label: 'TEST Stable A' }, UNBUILT);
  await swap.getByRole('combobox', { name: 'You receive' }).selectOption({ label: 'TEST Stable B' });
  await swap.getByRole('textbox', { name: /^Amount you pay/ }).fill('100');
  const fees = swap.getByRole('region', { name: 'Fees' });
  await expect(fees.getByTestId('fee-rule')).toHaveText('Stable pair rule');
  const lp = amount(await fees.getByTestId('fee-lp').innerText());
  const platform = amount(await fees.getByTestId('fee-platform').innerText());
  expect(amount(await fees.getByTestId('fee-total').innerText())).toBe(lp + platform);
});

test(`${J} #3 crosses the first TEST volume tier: the next assessment sets the tier and shows its inputs`, async ({ page }) => {
  await person(page);
  await page.goto('/fees/my-tier');
  const tier = main(page).getByRole('region', { name: 'Your tier' });
  await expect(tier.getByRole('term').filter({ hasText: 'Assessed' })).toBeVisible(UNBUILT);
  for (const input of ['30-day volume', 'IFC staked', 'Next assessment'])
    await expect(tier.getByRole('term').filter({ hasText: input })).toBeVisible();
  await expect(tier.getByTestId('tier-name')).not.toHaveText('Regular');
});

test(`${J} #4 reads the fee line with integrator fees on a swap: each fee entry and the output after fees; positive slippage stays with the swapper`, async ({
  page,
}) => {
  await connectWallet(page, dex, { tokens: [TOKEN_A, TOKEN_B] });
  await page.goto('/dex?integrator=test-integrator');
  const swap = page.getByRole('form', { name: 'Swap' });
  await swap.getByRole('combobox', { name: 'You pay' }).selectOption({ label: TOKEN_A.name }, UNBUILT);
  await swap.getByRole('combobox', { name: 'You receive' }).selectOption({ label: TOKEN_B.name });
  await swap.getByRole('textbox', { name: /^Amount you pay/ }).fill('10');
  const entries = swap.getByRole('list', { name: 'Fee entries' }).getByRole('listitem');
  await expect(entries.filter({ hasText: /^Integrator fee/ })).toHaveCount(1);
  await expect(swap.getByTestId('output-after-fees')).toHaveText(/^You receive [\d,.]+ TEST Token B after fees$/);
  await expect(swap.getByRole('note')).toContainText('Any price better than quoted stays with you.');
});

test(`${J} #5 reads maker rebates and the futures cost breakdown: rebate = tier rate × maker volume, paid once per period; the futures total equals its parts; the borrow-fee disclosure`, async ({
  page,
}) => {
  await person(page);
  await page.goto('/fees');
  const rebates = main(page).getByRole('region', { name: 'Maker rebates' });
  await expect(rebates).toBeVisible(UNBUILT);
  const rate = amount(await rebates.getByTestId('rebate-rate').innerText());
  const volume = amount(await rebates.getByTestId('maker-volume').innerText());
  const SCALE = 10n ** 18n;
  // The rate is shown in percent: rate / 100 × volume, rounded down to the decimals the page shows.
  const due = await rebates.getByTestId('rebate-due').innerText();
  const step = 10n ** BigInt(18 - shownDecimals(due));
  expect(amount(due)).toBe(((rate * volume) / (100n * SCALE) / step) * step);
  await expect(bodyRows(tableIn(rebates, 'Rebate payments')).filter({ hasText: 'Paid' })).toHaveCount(1);
  const futures = main(page).getByRole('region', { name: 'Futures costs' });
  const parts = ['cost-trading', 'cost-funding', 'cost-borrow'];
  let sum = 0n;
  for (const part of parts) sum += amount(await futures.getByTestId(part).innerText());
  expect(amount(await futures.getByTestId('cost-total').innerText())).toBe(sum);
  await expect(futures).toContainText('Borrow fee');
});

test(`${J} #6 shares a customer referral code: the code and its terms; no code is invented when the programme is blank`, async ({
  page,
}) => {
  await person(page);
  await page.goto('/fees');
  await main(page).getByRole('link', { name: 'Refer a friend' }).click(UNBUILT);
  const referral = main(page).getByRole('region', { name: 'Your referral code' });
  // The owner's referral programme is blank on the stack: no code, and the reason in its place.
  await expect(referral).toContainText('The referral programme is not set, so there is no code to share.');
  await expect(referral.getByTestId('referral-code')).toHaveCount(0);
});

test(`${J} #7 stakes IFC on a plan: with plans unpublished "no stake plans published"; an unstake before the lock is refused; an old stake keeps its old multiplier`, async ({
  page,
}) => {
  await person(page);
  await page.goto('/earn/ifc');
  const plans = main(page).getByRole('region', { name: 'IFC stake plans' });
  await expect(plans).toBeVisible(UNBUILT);
  await expect(plans).toContainText('No stake plans published');
  await expect(plans.getByRole('button', { name: 'Stake' })).toHaveCount(0);
});

test(`${J} #8 stakes governance tokens and delegates the vote: a cooldown before funds return; the delegate's power rises, the delegator's own vote refused; a blank timelock refuses`, async ({
  page,
}) => {
  await person(page);
  await page.goto('/governance');
  const stake = main(page).getByRole('form', { name: 'Stake for votes' });
  await expect(stake).toBeVisible(UNBUILT);
  await stake.getByRole('textbox', { name: /^Amount of IFC/ }).fill('10');
  await stake.getByRole('button', { name: 'Stake' }).click();
  await expect(main(page).getByTestId('cooldown')).toHaveText(/^Cooldown \d+ (days|hours) before funds return$/);
  const delegate = main(page).getByRole('form', { name: 'Delegate your vote' });
  await delegate.getByRole('textbox', { name: /^Delegate/ }).fill('test-delegate');
  await delegate.getByRole('button', { name: 'Delegate' }).click();
  await expect(main(page).getByTestId('voting-power')).toHaveText('Your votes are delegated to test-delegate');
  await main(page).getByRole('button', { name: 'Vote on TEST proposal' }).click();
  await expect(main(page).getByRole('alert')).toContainText('You delegated your vote');
  await expect(main(page)).toContainText('governance.timelock_unset');
});

test(`${J} #9 opens the burn page: stored buyback runs that add up per row; "job not set" or "empty book" as real readings; no estimate when the rate is blank`, async ({
  page,
}) => {
  await person(page);
  await page.goto('/token/burn');
  const runs = tableIn(main(page), 'Buyback runs');
  await expect(runs).toBeVisible(UNBUILT);
  const headers = ['Settled', 'Revenue window', 'Bought', 'Burned', 'Sent to rewards'];
  await expect(runs.getByRole('columnheader')).toHaveText(headers);
  // Every stored run on the page adds up: what was bought is what was burned plus what was sent to rewards.
  for (const row of await bodyRows(runs).all()) {
    const [bought, burned, rewards] = (await row.getByRole('cell').allInnerTexts()).slice(2).map(amount);
    expect(bought).toBe(burned + rewards);
  }
  // The test stack runs no buyback job (BUYBACK_JOB_ENABLED is false there), so the real reading is "Job not set".
  await expect(main(page).getByTestId('buyback-job')).toHaveText(/^Job not set: /);
  // The stack leaves the buyback rate blank, as production does until the owner sets it.
  await expect(main(page).getByTestId('buyback-estimate')).toHaveText('No estimate: the buyback rate is not set.');
});
