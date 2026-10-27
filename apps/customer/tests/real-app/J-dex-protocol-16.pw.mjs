import { test, expect } from '@playwright/test';
import { UNBUILT, connectWallet, dexRun } from './dex.mjs';
import { bodyRows, tableIn } from './tables.mjs';

// J-dex-protocol-16, in the running app (docs/roadmap/journeys.json): stake with a validator on INTACHAIN and look at
// INTACORE. One test per step, titled "J-dex-protocol-16 #<n>", run in order with one TEST wallet on Base Sepolia. The
// INTACHAIN lane is approved but its node is not connected here, so every room is honest: its table headers and its
// blocker, never a made-up validator, reward or book. Nothing moves: stake and unstake refuse until the chain service is
// connected. chain.go for every write; rail.crypto while no INTACHAIN node is configured; audit.external for mainnet.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - /chain/validators has the "Validator set" table and disabled Stake and Unstake with chain.go (#1 passes), but a
//   validator page is a pending page with no stake form, and there is no unstake queue, lockup, rewards, liquid staking
//   token or governance desk (D-lend-earn-07, -08);
// - the Web3 pages carry a "Not INTACHAIN · not audited" banner but no network chip (D-order-controls-02);
// - /chain/intacore does not exist: no Markets, Book, Margin or Finality tabs (RC-dex-protocol-07).
const J = 'J-dex-protocol-16';
const dex = dexRun(J);

test.describe.configure({ mode: 'default' });

const main = (page) => page.getByRole('main');
const section = (page, name) => main(page).getByRole('group', { name: 'Sections' }).getByRole('button', { name, exact: true });

/** Opens the validator page of the first validator /chain/validators would list, or the TEST id while none is listed. */
async function openValidator(page) {
  await connectWallet(page, dex);
  await page.goto('/chain/validators/test-validator-1');
  await expect(main(page).getByRole('heading', { level: 1 })).toBeVisible();
}

test(`${J} starts: a TEST wallet; the INTACHAIN lane approved but its node not connected here`, async ({ page }) => {
  dex.start();
  await connectWallet(page, dex);
  await page.goto('/chain');
  await expect(main(page).getByText('Not INTACHAIN · not audited')).toBeVisible();
});

test(`${J} #1 opens Validators: the table headers and a sentence saying why it is empty, never a made-up validator`, async ({ page }) => {
  await page.goto('/chain/validators');
  await expect(section(page, 'Validators')).toHaveAttribute('aria-pressed', 'true');
  const validators = tableIn(main(page), 'Validator set');
  for (const header of ['Validator', 'Stake', 'Status']) await expect(validators.getByRole('columnheader', { name: header })).toBeVisible();
  const rows = bodyRows(validators);
  await expect(rows).toHaveCount(1);
  await expect(rows).toHaveText(/no validator set because the INTACHAIN network is not running|not connected here/);
});

test(`${J} #2 opens a validator page and presses Stake: the stake form in full, disabled with the chain.go blocker; a blank staking parameter shows its typed refusal`, async ({
  page,
}) => {
  await openValidator(page);
  await main(page).getByRole('button', { name: 'Stake', exact: true }).click(UNBUILT);
  const form = page.getByRole('form', { name: 'Stake' });
  await expect(form.getByRole('textbox', { name: /^Amount/ })).toBeVisible();
  await expect(form.getByRole('button', { name: 'Review stake' })).toBeDisabled();
  await expect(form.getByRole('note')).toContainText('chain.go');
  await expect(form).toContainText('chain.staking.min_stake_unset');
});

test(`${J} #3 reads the unstake queue and lockup: lockup terms as typed parameters or "Not set"; the controls reachable at 360 px`, async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await openValidator(page);
  const queue = main(page).getByRole('region', { name: 'Unstake queue' });
  await expect(queue).toBeVisible(UNBUILT);
  for (const term of ['Lockup', 'Unbonding period']) {
    const value = queue.getByRole('term').filter({ hasText: term });
    await expect(value).toBeVisible();
  }
  await expect(queue.getByRole('definition').filter({ hasText: /^(Not set|\d+ (blocks|days))$/ })).toHaveCount(2);
  const unstake = queue.getByRole('button', { name: 'Unstake' });
  await unstake.scrollIntoViewIfNeeded();
  await expect(unstake).toBeInViewport();
});

test(`${J} #4 opens staking rewards and the liquid staking token: each control shows the blocker; a rewards call returns the refusal and no number`, async ({
  page,
}) => {
  await openValidator(page);
  const rewards = main(page).getByRole('region', { name: 'Staking rewards' });
  await expect(rewards).toBeVisible(UNBUILT);
  for (const name of ['Claim rewards', 'Mint liquid staking token', 'Redeem liquid staking token']) {
    const control = main(page).getByRole('button', { name });
    await expect(control).toBeDisabled();
    await expect(main(page).getByRole('note').filter({ hasText: name })).toContainText('chain.go');
  }
  await expect(rewards.getByTestId('rewards-earned')).toHaveText('Not available: the chain service is not connected.');
  await expect(rewards.getByText(/^\d[\d,.]*$/)).toHaveCount(0);
});

test(`${J} #5 opens the validator governance desk: "Validator set unavailable: the chain service is not connected." and no enabled write control`, async ({
  page,
}) => {
  await page.goto('/chain/validators');
  await main(page).getByRole('link', { name: 'Validator governance' }).click(UNBUILT);
  await expect(main(page)).toContainText('Validator set unavailable: the chain service is not connected.');
  const controls = main(page)
    .getByRole('button')
    .filter({ hasText: /^(Propose|Vote|Execute)/ });
  await expect(controls).not.toHaveCount(0);
  for (const control of await controls.all()) await expect(control).toBeDisabled();
});

test(`${J} #6 checks the network chip on each page: the same testnet chip; nothing calls Base the INTACHAIN mainnet and no row says audited`, async ({
  page,
}) => {
  await connectWallet(page, dex);
  for (const path of ['/chain', '/chain/validators', '/dex', '/wallet', '/protocol']) {
    await page.goto(path);
    const chip = page.getByRole('status', { name: 'Network' });
    await expect(chip, path).toHaveText('Base Sepolia · testnet', UNBUILT);
    const text = await main(page).innerText();
    expect(text, path).not.toMatch(/INTACHAIN mainnet/i);
    expect(text.replace(/not audited/gi, ''), path).not.toMatch(/\baudited\b/i);
  }
});

test(`${J} #7 opens INTACORE: four tabs with headers, empty bodies and the blocker; Place order refuses with the crypto network notice; a TEST adapter shows exactly its rows labelled TEST`, async ({
  page,
}) => {
  await connectWallet(page, dex);
  await page.goto('/chain/intacore');
  const tabs = main(page).getByRole('group', { name: 'INTACORE sections' });
  await expect(tabs).toBeVisible(UNBUILT);
  for (const [tab, table, header] of [
    ['Markets', 'Markets', 'Market'],
    ['Book', 'Order book', 'Price'],
    ['Margin', 'Margin account', 'Asset'],
    ['Finality', 'Finality', 'Block'],
  ]) {
    await tabs.getByRole('button', { name: tab, exact: true }).click();
    const rows = tableIn(main(page), table);
    await expect(rows.getByRole('columnheader', { name: header })).toBeVisible();
    await expect(bodyRows(rows).filter({ hasNotText: /rail\.crypto|TEST/ })).toHaveCount(0);
  }
  await tabs.getByRole('button', { name: 'Book', exact: true }).click();
  await main(page).getByRole('button', { name: 'Place order' }).click();
  await expect(main(page).getByRole('alert')).toContainText('rail.crypto');
});
