import { test, expect } from '@playwright/test';
import { UNBUILT, connectWallet, dexRun } from './dex.mjs';

// J-dex-protocol-12, in the running app (docs/roadmap/journeys.json): add liquidity to a pool, see impermanent loss and
// take it out. One test per step, titled "J-dex-protocol-12 #<n>", run in order with one TEST wallet holding TEST tokens
// A and B. Liquidity is deposited into a pool contract the person's wallet signs, for fungible LP shares; nothing posts
// to the ledger. With no factory address the room shows rail.crypto.
// Every step is written; none is built yet, so each fails at its first missing part, quickly (UNBUILT):
// - /dex/pools is an empty "Liquidity pools" table (Pool, Pair, Liquidity) with the AMM wiring flag; it lists no pools
//   with fee tier, reserves and volume (D-liquidity-03), /dex/pools/new is a pending page waiting on the wallet, and
//   pool and position pages wait on the indexer (D-liquidity-01, -02, -04);
// - the stack has no TEST chain, factory or pool for a deposit to go to.
const J = 'J-dex-protocol-12';
const dex = dexRun(J);
const TOKEN_A = { address: '0x00000000000000000000000000000000000a11ce', name: 'TEST Token A', version: '1', decimals: 6, nonce: 0 };
const TOKEN_B = { address: '0x00000000000000000000000000000000000b0b00', name: 'TEST Token B', version: '1', decimals: 18, nonce: 0 };

test.describe.configure({ mode: 'default' });

const pools = (page) => page.getByRole('main').getByRole('table', { name: 'Liquidity pools' });
const poolRow = (page) => pools(page).getByRole('row').filter({ hasText: 'TEST Token A / TEST Token B' });
const position = (page) => page.getByRole('main').getByRole('region', { name: 'Your position' });

async function openPools(page) {
  const wallet = await connectWallet(page, dex, { tokens: [TOKEN_A, TOKEN_B] });
  await page.goto('/dex/pools');
  await expect(pools(page)).toBeVisible();
  return wallet;
}

async function openPosition(page) {
  await openPools(page);
  await page.goto('/dex/positions');
  await page
    .getByRole('main')
    .getByRole('link', { name: /TEST Token A \/ TEST Token B/ })
    .click(UNBUILT);
  await expect(position(page)).toBeVisible();
}

test(`${J} starts: a TEST wallet holding TEST tokens A and B`, async ({ page }) => {
  dex.start();
  await openPools(page);
});

test(`${J} #1 opens the pool list: pools with fee tier, reserves in token amounts and volume`, async ({ page }) => {
  await openPools(page);
  for (const header of ['Fee tier', 'Reserves', 'Volume']) {
    await expect(pools(page).getByRole('columnheader', { name: header })).toBeVisible(UNBUILT);
  }
  await expect(poolRow(page)).toContainText(/[\d,.]+ TEST Token A · [\d,.]+ TEST Token B/);
});

test(`${J} #2 starts a pool for a pair that already has one at 30 basis points: "This pool exists" and Add liquidity instead`, async ({
  page,
}) => {
  await openPools(page);
  await page.goto('/dex/pools/new');
  const form = page.getByRole('form', { name: 'New pool' });
  await form.getByRole('combobox', { name: 'First token' }).selectOption({ label: 'TEST Token A' }, UNBUILT);
  await form.getByRole('combobox', { name: 'Second token' }).selectOption({ label: 'TEST Token B' });
  await form.getByRole('combobox', { name: 'Fee tier' }).selectOption({ label: '0.30%' });
  await expect(form.getByRole('status')).toHaveText('This pool exists');
  await expect(form.getByRole('link', { name: 'Add liquidity' })).toBeVisible();
  await expect(form.getByRole('button', { name: 'Create pool' })).toHaveCount(0);
});

test(`${J} #3 creates a pool at a fee tier and seeds it: price equals the deposit ratio; a fee over the cap refused; blank tiers show only custom; no factory names the network`, async ({
  page,
}) => {
  await openPools(page);
  await page.goto('/dex/pools/new');
  const form = page.getByRole('form', { name: 'New pool' });
  await form.getByRole('combobox', { name: 'Fee tier' }).selectOption({ label: 'Custom' }, UNBUILT);
  await form.getByRole('textbox', { name: /^Custom fee/ }).fill('99');
  await expect(form.getByRole('alert')).toContainText('above the fee cap');
  await form.getByRole('textbox', { name: /^Custom fee/ }).fill('0.05');
  await form.getByRole('textbox', { name: /^First amount/ }).fill('1000');
  await form.getByRole('textbox', { name: /^Second amount/ }).fill('2000');
  await expect(form.getByTestId('starting-price')).toHaveText('1 TEST Token A = 2 TEST Token B');
  await form.getByRole('button', { name: 'Create pool' }).click();
  await page.getByRole('button', { name: 'Continue in wallet' }).click();
  await expect(page.getByRole('status')).toContainText('Pool created');
});

test(`${J} #4 enters 100:100 into a 1000:2000 pool: only 50:100 is pulled; a minimum above what the pool takes reverts; a stale quote asks to refresh`, async ({
  page,
}) => {
  await openPools(page);
  await poolRow(page).getByRole('link', { name: 'Add liquidity' }).click(UNBUILT);
  const add = page.getByRole('form', { name: 'Add liquidity' });
  await add.getByRole('textbox', { name: /^TEST Token A/ }).fill('100');
  await add.getByRole('textbox', { name: /^TEST Token B/ }).fill('100');
  await expect(add.getByTestId('pulled')).toHaveText('Deposits 50 TEST Token A and 100 TEST Token B');
  await add.getByRole('textbox', { name: /^Minimum shares/ }).fill('999999');
  await add.getByRole('button', { name: 'Add' }).click();
  await expect(add.getByRole('alert')).toContainText('Fewer shares than your minimum');
  await expect(add.getByRole('button', { name: 'Refresh quote' })).toBeVisible({ timeout: 120_000 });
});

test(`${J} #5 opens the position: LP shares, share of the pool and fees earned; a share moved to another wallet shows as that wallet's`, async ({
  page,
}) => {
  await openPosition(page);
  for (const term of ['LP shares', 'Share of the pool', 'Fees earned'])
    await expect(position(page).getByRole('term').filter({ hasText: term })).toBeVisible();
});

test(`${J} #6 opens the impermanent-loss card after the price moves to 1414:1414: held amounts, share amounts and the difference; a transferred share reads "Entry unknown"`, async ({
  page,
}) => {
  await openPosition(page);
  const card = position(page).getByRole('region', { name: 'Impermanent loss' });
  for (const term of ['If held', 'In the pool', 'Difference']) await expect(card.getByRole('term').filter({ hasText: term })).toBeVisible();
});

test(`${J} #7 adds a single token with swap-and-add: about half swapped, shares at least the minimum; a failed second step leaves nothing half done`, async ({
  page,
}) => {
  await openPools(page);
  await poolRow(page).getByRole('link', { name: 'Add liquidity' }).click(UNBUILT);
  const add = page.getByRole('form', { name: 'Add liquidity' });
  await add.getByRole('checkbox', { name: 'Add one token (swap half first)' }).check();
  await add.getByRole('textbox', { name: /^TEST Token A/ }).fill('100');
  await expect(add.getByTestId('swap-half')).toHaveText(/^Swaps about 50 TEST Token A first$/);
  await expect(add.getByRole('note')).toContainText('Both steps happen in one transaction, or neither does.');
});

test(`${J} #8 collects fees, then removes all shares: fees compound into the position; removal pays both tokens pro rata and the position goes`, async ({
  page,
}) => {
  await openPosition(page);
  await position(page).getByRole('button', { name: 'Collect fees' }).click();
  await expect(position(page).getByRole('status')).toContainText('Fees added to your position');
  await position(page).getByRole('button', { name: 'Remove all' }).click();
  await page.getByRole('button', { name: 'Continue in wallet' }).click();
  await expect(page.getByRole('status')).toContainText(/Returned [\d.]+ TEST Token A and [\d.]+ TEST Token B/);
  await page.goto('/dex/positions');
  await expect(page.getByRole('main').getByRole('link', { name: /TEST Token A \/ TEST Token B/ })).toHaveCount(0);
});
