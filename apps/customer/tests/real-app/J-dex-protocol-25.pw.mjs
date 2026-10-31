import { test, expect } from './journey.mjs';
import { TOKEN_A, TOKEN_B, UNBUILT, connectWallet, dexRun, seededWallet } from './dex.mjs';
import { bodyRows, tableIn } from './tables.mjs';

// J-dex-protocol-25, in the running app (docs/roadmap/journeys.json): run a fair-launch auction and deploy a spot token
// with a genesis allocation. One test per step, titled "J-dex-protocol-25 #<n>", run in order with one TEST wallet that
// sells TEST Token A for TEST Token B, and a second TEST wallet (a contributor, in its own browser). Contributions are
// held by the sale contract; a claim pays once; a failed sale refunds in full; nothing posts to the ledger.
// audit.external for mainnet; rail.crypto while the node is absent.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - /protocol/contracts shows Launch token disabled with rail.crypto; there is no fair-launch wizard, sale page, claim,
//   refund or pool migration (D-launch-listing-09). The contribution, refund and vesting claim rules are proven on chain
//   in services/svc-protocol (fair-launch.onchain.test.ts), but no room opens them;
// - there is no spot token deploy with genesis allocations and no bridged or real-world asset registration
//   (D-launch-listing-07);
// - the stack has no TEST chain or clock control, so #3 to #6 use TEST sales the stack will seed when the rooms are
//   built: `TEST open sale` (open now, a cap of 50 per wallet), `TEST failed sale` (ended under its minimum raise) and
//   `TEST finished sale` (finalised), with the stack's seeded TEST wallet as contributor and seller (dex.mjs). The sale
//   #2 starts opens in 2030, so no contribution can reach it yet.
const J = 'J-dex-protocol-25';
const dex = dexRun(J);
const TOKENS = [TOKEN_A, TOKEN_B];

test.describe.configure({ mode: 'default' });

const main = (page) => page.getByRole('main');
const wizard = (page) => main(page).getByRole('form', { name: 'Fair launch' });

/** Opens the fair-launch wizard from the protocol's contracts room with the run's wallet connected. */
async function openWizard(page) {
  const wallet = await connectWallet(page, dex, { tokens: TOKENS });
  await page.goto('/protocol/contracts');
  await main(page).getByRole('button', { name: 'Launch token' }).click(UNBUILT);
  await main(page)
    .getByRole('radio', { name: /^Fair launch/ })
    .check();
  await expect(wizard(page)).toBeVisible();
  return wallet;
}

/** Fills the wizard with TEST values; `minimumRaise` and `walletCap` vary per step. */
async function fill(page, { minimumRaise = '100', walletCap = '50' } = {}) {
  const form = wizard(page);
  await form.getByRole('textbox', { name: /^Tokens for sale/ }).fill('10000');
  await form.getByRole('textbox', { name: /^Minimum raise in TEST Token B/ }).fill(minimumRaise);
  await form.getByRole('textbox', { name: /^Cap per wallet/ }).fill(walletCap);
  await form.getByLabel('Starts').fill('2030-01-01T00:00');
  await form.getByLabel('Ends').fill('2030-01-08T00:00');
}

/** Signs whatever the open sheet asks for. */
async function sign(page) {
  await page.getByRole('dialog', { name: 'Check before you sign' }).getByRole('button', { name: 'Continue in wallet' }).click();
}

/** One TEST sale's page on the launches list. */
async function sale(page, name) {
  await page.goto('/dex/launches');
  const region = main(page).getByRole('region', { name });
  await expect(region).toBeVisible(UNBUILT);
  return region;
}

test(`${J} starts: a connected TEST wallet, a token to sell and a quote asset`, async ({ page }) => {
  dex.start();
  await connectWallet(page, dex, { tokens: TOKENS });
});

test(`${J} #1 opens the wizard and sets a minimum raise of 0: "Bad configuration" mirrored by the form before sending`, async ({
  page,
}) => {
  const wallet = await openWizard(page);
  await fill(page, { minimumRaise: '0' });
  await wizard(page).getByRole('button', { name: 'Review' }).click();
  await expect(wizard(page).getByRole('alert')).toContainText('Bad configuration: the minimum raise must be above 0');
  expect(wallet.sends).toHaveLength(0);
});

test(`${J} #2 sets valid parameters and starts the sale: every value immutable and the schedule`, async ({ page }) => {
  const wallet = await openWizard(page);
  await fill(page);
  await wizard(page).getByRole('button', { name: 'Review' }).click();
  await sign(page);
  await expect.poll(() => wallet.sends.length).toBe(1);
  const params = main(page).getByRole('region', { name: 'Sale parameters' });
  await expect(params).toContainText('These values cannot be changed', { timeout: 60_000 });
  for (const term of ['Tokens for sale', 'Minimum raise', 'Cap per wallet', 'Starts', 'Ends'])
    await expect(params.getByRole('term').filter({ hasText: term })).toBeVisible();
  await expect(params.getByRole('textbox')).toHaveCount(0);
});

test(`${J} #3 a contributor bids above the wallet cap: the form pre-checks it and nothing is sent`, async ({ page }) => {
  // A contributor's own TEST wallet, not the seller's.
  const wallet = await connectWallet(page, dexRun(`${J}-contributor`), { tokens: TOKENS });
  const region = await sale(page, 'TEST open sale');
  await region.getByRole('textbox', { name: /^Contribute in TEST Token B/ }).fill('51');
  await region.getByRole('button', { name: 'Review' }).click();
  await expect(region.getByRole('alert')).toContainText('Above the cap of 50 per wallet');
  // Nothing is sent; the contract reverting an over-cap bid that skips the form is its own on-chain test.
  expect(wallet.sends).toHaveLength(0);
});

test(`${J} #4 the sale ends under the minimum raise: contributors refund in full`, async ({ page }) => {
  await connectWallet(page, seededWallet, { tokens: TOKENS });
  const region = await sale(page, 'TEST failed sale');
  await expect(region).toContainText('Ended under the minimum raise');
  await region.getByRole('button', { name: 'Refund my contribution' }).click();
  await sign(page);
  await expect(region.getByTestId('my-contribution')).toHaveText(/^Refunded in full: [\d,.]+ TEST Token B$/, { timeout: 60_000 });
});

test(`${J} #5 the sale finalises: claim works once and a second claim shows nothing; vesting claims follow the cliff and the linear period`, async ({
  page,
}) => {
  await connectWallet(page, seededWallet, { tokens: TOKENS });
  const region = await sale(page, 'TEST finished sale');
  await region.getByRole('button', { name: 'Claim' }).click();
  await sign(page);
  await expect(region.getByTestId('claimable')).toHaveText('Nothing to claim', { timeout: 60_000 });
  await expect(region.getByRole('button', { name: 'Claim' })).toBeDisabled();
  const schedule = tableIn(region, 'Vesting schedule');
  await expect(bodyRows(schedule).filter({ hasText: 'Before the cliff' })).toContainText('0%');
  await expect(bodyRows(schedule).filter({ hasText: 'Linear' })).toBeVisible();
});

test(`${J} #6 migrates the proceeds to a pool: a v2 pool seeded at the sale price with the LP locked`, async ({ page }) => {
  await connectWallet(page, seededWallet, { tokens: TOKENS });
  const region = await sale(page, 'TEST finished sale');
  await region.getByRole('button', { name: 'Migrate to a pool' }).click();
  await sign(page);
  const pool = region.getByRole('region', { name: 'Pool' });
  await expect(pool).toContainText('v2 pool', { timeout: 60_000 });
  await expect(pool.getByTestId('pool-price')).toHaveText(await region.getByTestId('sale-price').innerText());
  await expect(pool).toContainText('LP locked');
});

test(`${J} #7 deploys a spot token on the test network with genesis allocations that sum to supply minus one: refused; a correct sum is a labelled rehearsal`, async ({
  page,
}) => {
  await openWizard(page);
  await main(page)
    .getByRole('radio', { name: /^Spot token/ })
    .check();
  const form = main(page).getByRole('form', { name: 'Spot token' });
  await form.getByRole('textbox', { name: /^Supply/ }).fill('1000');
  const allocations = form.getByRole('group', { name: 'Genesis allocations' });
  await allocations
    .getByRole('textbox', { name: /^Amount/ })
    .first()
    .fill('999');
  await form.getByRole('button', { name: 'Review' }).click();
  await expect(form.getByRole('alert')).toContainText('Allocations sum to 999, not the supply of 1000');
  await allocations
    .getByRole('textbox', { name: /^Amount/ })
    .first()
    .fill('1000');
  await form.getByRole('button', { name: 'Review' }).click();
  await expect(page.getByRole('dialog', { name: 'Check before you sign' })).toContainText('Rehearsal on the test network');
});

test(`${J} #8 registers a bridged or real-world asset with the reference hash unset: the owner-decision label and no registration`, async ({
  page,
}) => {
  const wallet = await openWizard(page);
  await main(page)
    .getByRole('radio', { name: /^Bridged or real-world asset/ })
    .check();
  const form = main(page).getByRole('form', { name: 'Register an asset' });
  await expect(form.getByRole('note')).toContainText('owner.decision');
  await expect(form.getByRole('button', { name: 'Review' })).toBeDisabled();
  expect(wallet.sends).toHaveLength(0);
});
