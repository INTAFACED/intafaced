import { test, expect } from '@playwright/test';
import { TOKEN_A, TOKEN_B, UNBUILT, connectWallet, dexRun } from './dex.mjs';
import { bodyRows, tableIn } from './tables.mjs';

// J-dex-protocol-13, in the running app (docs/roadmap/journeys.json): run advanced pools with ranges, hooks, permissioned
// markets and incentives. One test per step, titled "J-dex-protocol-13 #<n>", run in order with one TEST wallet holding
// TEST tokens A and B, in pools the owner has opened for each pool type. Every position is in a pool contract the
// person's wallet signs; nothing posts to the ledger, and hook and permissioned pools always let liquidity out.
// owner.decision shows for each gated pool type until the owner opens it; rail.crypto while the node is absent.
// Every step is written; none is built yet, so each fails at its first missing part, quickly (UNBUILT):
// - /dex/pools is an empty "Liquidity pools" table with no pool types, and /dex/pools/new and pool pages are pending
//   pages, so there are no range positions or range orders (D-liquidity-05), hook pools (D-liquidity-06), permissioned
//   pools (D-liquidity-07), dynamic fees (D-liquidity-08) or incentives and the venue strategy (D-liquidity-09);
// - the stack has no TEST chain, factory, hook or pool, so no price moves and nothing a step signs can mine.
const J = 'J-dex-protocol-13';
const dex = dexRun(J);

test.describe.configure({ mode: 'default' });

const pools = (page) => tableIn(page.getByRole('main'), 'Liquidity pools');
const position = (page) => page.getByRole('main').getByRole('region', { name: 'Your position' });

/** Opens /dex/pools with the run's wallet connected. */
async function openPools(page) {
  const wallet = await connectWallet(page, dex, { tokens: [TOKEN_A, TOKEN_B] });
  await page.goto('/dex/pools');
  await expect(pools(page)).toBeVisible();
  return wallet;
}

/** Opens the pool of `type` (Range, Hook, Stable, Permissioned) for TEST tokens A and B, connecting the wallet first. */
async function openPool(page, type) {
  await openPools(page);
  return choosePool(page, type);
}

/** From /dex/pools with the wallet already connected, opens the pool of `type` for TEST tokens A and B. */
async function choosePool(page, type) {
  await page.goto('/dex/pools');
  await page.getByRole('main').getByRole('group', { name: 'Pool type' }).getByRole('button', { name: type }).click(UNBUILT);
  await bodyRows(pools(page)).filter({ hasText: 'TEST Token A / TEST Token B' }).getByRole('link').click();
  const pool = page.getByRole('main').getByRole('region', { name: 'Pool' });
  await expect(pool).toBeVisible();
  return pool;
}

test(`${J} starts: a TEST wallet holding TEST tokens A and B, with a pool of each type the owner opened`, async ({ page }) => {
  dex.start();
  await openPools(page);
  const types = page.getByRole('main').getByRole('group', { name: 'Pool type' });
  for (const type of ['Range', 'Hook', 'Stable', 'Permissioned'])
    await expect(types.getByRole('button', { name: type })).toBeVisible(UNBUILT);
});

test(`${J} #1 opens a range position inside the price: fees accrue; when the price leaves the range it reads out of range and accrual stops`, async ({
  page,
}) => {
  const pool = await openPool(page, 'Range');
  await pool.getByRole('button', { name: 'Add a range position' }).click();
  const form = page.getByRole('form', { name: 'Range position' });
  await form.getByRole('button', { name: 'Around the current price' }).click();
  await form.getByRole('textbox', { name: /^Amount of TEST Token A/ }).fill('10');
  await form.getByRole('button', { name: 'Review' }).click();
  await page.getByRole('button', { name: 'Continue in wallet' }).click();
  await expect(position(page).getByRole('status')).toHaveText('In range', { timeout: 60_000 });
  await expect(position(page).getByTestId('fees-earned')).not.toHaveText(/^0(\.0+)? /, { timeout: 60_000 });
  // The TEST price moves outside the range: the position says so and stops earning.
  await expect(position(page).getByRole('status')).toHaveText('Out of range: not earning fees', { timeout: 120_000 });
});

test(`${J} #2 places a range order: after the price crosses it holds only the other token; a blank tick spacing refuses`, async ({
  page,
}) => {
  const pool = await openPool(page, 'Range');
  await pool.getByRole('button', { name: 'Place a range order' }).click();
  const form = page.getByRole('form', { name: 'Range order' });
  await form.getByRole('textbox', { name: /^Sell TEST Token A at/ }).fill('1.1');
  await form.getByRole('textbox', { name: /^Amount/ }).fill('5');
  await form.getByRole('button', { name: 'Review' }).click();
  await page.getByRole('button', { name: 'Continue in wallet' }).click();
  await expect(position(page)).toContainText(/Holds only TEST Token B/, { timeout: 120_000 });
  // A pool whose owner left the tick spacing blank refuses the build by name.
  await page.goto('/dex/pools');
  await page.getByRole('main').getByRole('group', { name: 'Pool type' }).getByRole('button', { name: 'Range' }).click();
  await bodyRows(pools(page)).filter({ hasText: 'TEST no tick spacing' }).getByRole('link').click();
  await page.getByRole('button', { name: 'Place a range order' }).click();
  await expect(page.getByRole('alert')).toContainText('dex.pool.tick_spacing_unset');
});

test(`${J} #3 opens a hook pool: the hook, its risk review and the allowlist badge; a reverting hook blocks swaps with "hook reverted" while liquidity can still be removed`, async ({
  page,
}) => {
  const pool = await openPool(page, 'Hook');
  const hook = pool.getByRole('region', { name: 'Hook' });
  await expect(hook.getByRole('link', { name: 'Risk review' })).toBeVisible();
  await expect(hook.getByText('Routing allowlist', { exact: true })).toBeVisible();
  await page.goto('/dex');
  // The TEST hook pool whose hook reverts: the swap is blocked by name, the exit still builds.
  await page.getByRole('form', { name: 'Swap' }).getByRole('combobox', { name: 'Pool' }).selectOption({ label: 'TEST reverting hook' });
  await expect(page.getByRole('form', { name: 'Swap' }).getByRole('alert')).toContainText('hook reverted');
  await page.goBack();
  await pool.getByRole('button', { name: 'Remove liquidity' }).click();
  await expect(page.getByRole('dialog', { name: 'Check before you sign' })).toBeVisible();
});

test(`${J} #4 opens a stable pair and a skewed volatile pair: the stable fee is optimal inside the band and corrective outside; bid and ask fees differ within the cap`, async ({
  page,
}) => {
  const stable = await openPool(page, 'Stable');
  const fees = stable.getByRole('region', { name: 'Fees' });
  await expect(fees.getByTestId('fee-rule')).toHaveText(/^(Inside the band: optimal fee|Outside the band: corrective fee) [\d.]+ ?%$/);
  const volatile = await choosePool(page, 'Range');
  const sides = volatile.getByRole('region', { name: 'Fees' });
  const bid = await sides.getByTestId('fee-bid').innerText();
  const ask = await sides.getByTestId('fee-ask').innerText();
  expect(bid).not.toBe(ask);
  await expect(sides.getByTestId('fee-cap')).toHaveText(/^Cap [\d.]+ ?%$/);
});

test(`${J} #5 asks to change a fee hook parameter: it is a new hook and a new pool; the old pool keeps its rule`, async ({ page }) => {
  const pool = await openPool(page, 'Hook');
  const rule = await pool.getByTestId('fee-rule').innerText(UNBUILT);
  await pool.getByRole('button', { name: 'Change a fee parameter' }).click();
  const dialog = page.getByRole('dialog', { name: 'Change a fee parameter' });
  await expect(dialog).toContainText('A changed parameter is a new hook and a new pool. This pool keeps its rule.');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(pool.getByTestId('fee-rule')).toHaveText(rule);
});

test(`${J} #6 tries to swap in a permissioned pool without being allowlisted: "Not eligible", and removing liquidity still succeeds`, async ({
  page,
}) => {
  const pool = await openPool(page, 'Permissioned');
  await pool.getByRole('button', { name: 'Swap in this pool' }).click();
  await expect(page.getByRole('alert')).toContainText('Not eligible');
  await pool.getByRole('button', { name: 'Remove liquidity' }).click();
  await expect(page.getByRole('dialog', { name: 'Check before you sign' })).toBeVisible();
});

test(`${J} #7 reads the issuer controls: a halted swap shows its reason and exits still work; a position token cannot be transferred`, async ({
  page,
}) => {
  const pool = await openPool(page, 'Permissioned');
  const issuer = pool.getByRole('region', { name: 'Issuer controls' });
  await expect(issuer.getByText(/^Swaps halted: .+/)).toBeVisible();
  await expect(pool.getByRole('button', { name: 'Remove liquidity' })).toBeEnabled();
  await expect(issuer).toContainText('Position tokens in this pool cannot be transferred.');
  await expect(pool.getByRole('button', { name: /^Transfer/ })).toHaveCount(0);
});

test(`${J} #8 stakes LP shares into a TEST incentive of 1000 over 10 blocks: rewards split 750:250 for LPs holding 3:1; leaving stops accrual; an unfunded incentive cannot start`, async ({
  page,
}) => {
  const pool = await openPool(page, 'Range');
  const incentives = tableIn(pool, 'Incentives');
  const funded = bodyRows(incentives).filter({ hasText: 'TEST 1000 over 10 blocks' });
  await funded.getByRole('button', { name: 'Stake' }).click();
  await page.getByRole('button', { name: 'Continue in wallet' }).click();
  // The TEST incentive's other staker holds a third of this wallet's shares: this wallet's split is three quarters,
  // 750 of the 1000 over the full period.
  await expect(funded.getByTestId('your-split')).toHaveText('75% · 750 of 1000 TEST reward over the period', { timeout: 60_000 });
  // Leaving mid-period: once some reward has accrued, unstake; the reward stays where it was until the period ends.
  const reward = funded.getByTestId('your-reward');
  await expect(reward).not.toHaveText(/^0(\.0+)? TEST reward$/, { timeout: 60_000 });
  await funded.getByRole('button', { name: 'Unstake' }).click();
  await page.getByRole('button', { name: 'Continue in wallet' }).click();
  await expect(funded.getByRole('status')).toHaveText('Not earning', { timeout: 60_000 });
  const left = await reward.innerText();
  await expect(funded).toContainText('Period ended', { timeout: 120_000 });
  await expect(reward).toHaveText(left);
  const unfunded = bodyRows(incentives).filter({ hasText: 'TEST unfunded' });
  await expect(unfunded.getByRole('button', { name: 'Start' })).toBeDisabled();
  await expect(unfunded).toContainText('Not funded: cannot start');
});

test(`${J} #9 reads the protocol-run venue strategy: its orders sit with user orders at one price and get no priority`, async ({
  page,
}) => {
  await connectWallet(page, dex, { tokens: [TOKEN_A, TOKEN_B] });
  await page.goto('/dex/venue');
  const strategy = page.getByRole('main').getByRole('region', { name: 'Protocol strategy' });
  await expect(strategy).toBeVisible(UNBUILT);
  await expect(strategy).toContainText('Its orders queue with yours at the same price and get no priority.');
  await expect(tableIn(strategy, 'Strategy orders').getByRole('columnheader', { name: 'Queue position' })).toBeVisible();
});
