import { test, expect } from './journey.mjs';
import { TOKEN_A, TOKEN_B, UNBUILT, connectWallet, dexRun, oneAmount, seededWallet } from './dex.mjs';
import { toUnits } from './stack.mjs';
import { bodyRows, tableIn } from './tables.mjs';

// J-dex-protocol-28, in the running app (docs/roadmap/journeys.json): issue assets, raise funds and use the treasury
// yield vault. One test per step, titled "J-dex-protocol-28 #<n>", run in order with one TEST wallet that issues and
// raises, holding TEST Token A (the backing and the stables) and TEST Token B. Tokens sit in contracts under the
// signers; supply never exceeds proven backing; a missed goal refunds in full. feed.market for synthetic assets;
// owner.decision for the programme reference hash and the yield token; audit.external for mainnet.
// Step 4 (a real-world asset with an issuer and region gate) waits for launch prep (owner decision 2026-10-27) and has
// no test.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - /protocol has no Issue, Raise or Treasury vault section: no backed wrapped asset, synthetic tab
//   (RC-dex-protocol-10), milestone fundraising (RC-dex-protocol-09) or treasury yield vault (RC-dex-protocol-19);
// - the stack has no TEST chain or clock control, so #5 and #6 read TEST campaigns of the stack in the state the step
//   names (a missed goal, an approved milestone), and #8 a TEST vault with a 5 percent TEST gain; #6 and #8 act as the
//   stack's seeded TEST wallet (dex.mjs), the campaign's owner and the vault's depositor. The stack will seed them when
//   the rooms are built.
const J = 'J-dex-protocol-28';
const dex = dexRun(J);
const TOKENS = [TOKEN_A, TOKEN_B];

test.describe.configure({ mode: 'default' });

const main = (page) => page.getByRole('main');

/** Opens one section of the protocol room with the run's wallet (or `as`) connected. */
async function openSection(page, name, as = dex) {
  const wallet = await connectWallet(page, as, { tokens: TOKENS });
  await page.goto('/protocol');
  await main(page).getByRole('group', { name: 'Sections' }).getByRole('button', { name, exact: true }).click(UNBUILT);
  return wallet;
}

/** Signs whatever the open sheet asks for. */
async function sign(page) {
  await page.getByRole('dialog', { name: 'Check before you sign' }).getByRole('button', { name: 'Continue in wallet' }).click();
}

/** Reserve and supply of the run's backed asset, as shown. */
async function backing(page) {
  const asset = main(page).getByRole('region', { name: 'TEST Backed A' });
  return {
    asset,
    reserve: oneAmount(await asset.getByTestId('reserve').innerText()),
    supply: oneAmount(await asset.getByTestId('supply').innerText()),
  };
}

test(`${J} starts: a connected TEST wallet that issues or raises`, async ({ page }) => {
  dex.start();
  await connectWallet(page, dex, { tokens: TOKENS });
});

test(`${J} #1 issues 100 of a backed wrapped asset at ratio 1: reserve and supply both 100 and backed; a ratio of 0 refused`, async ({
  page,
}) => {
  const wallet = await openSection(page, 'Issue');
  const form = main(page).getByRole('form', { name: 'Issue a backed asset' });
  await form.getByRole('textbox', { name: /^Name/ }).fill('TEST Backed A');
  await form.getByRole('combobox', { name: 'Backing' }).selectOption({ label: TOKEN_A.name });
  await form.getByRole('textbox', { name: /^Amount/ }).fill('100');
  await form.getByRole('textbox', { name: /^Backing ratio/ }).fill('0');
  await form.getByRole('button', { name: 'Review' }).click();
  await expect(form.getByRole('alert')).toContainText('The backing ratio must be above 0');
  expect(wallet.sends).toHaveLength(0);
  await form.getByRole('textbox', { name: /^Backing ratio/ }).fill('1');
  await form.getByRole('button', { name: 'Review' }).click();
  await sign(page);
  await expect(main(page).getByRole('region', { name: 'TEST Backed A' })).toContainText('Backed: yes', { timeout: 60_000 });
  const { reserve, supply } = await backing(page);
  expect(reserve).toBe(toUnits('100'));
  expect(supply).toBe(toUnits('100'));
});

test(`${J} #2 redeems 40: supply 60 and reserve 60`, async ({ page }) => {
  await openSection(page, 'Issue');
  const { asset } = await backing(page);
  await asset.getByRole('textbox', { name: /^Redeem/ }).fill('40');
  await asset.getByRole('button', { name: 'Review' }).click();
  await sign(page);
  await expect(asset.getByTestId('supply')).toContainText('60', { timeout: 60_000 });
  const { reserve, supply } = await backing(page);
  expect(supply).toBe(toUnits('60'));
  expect(reserve).toBe(toUnits('60'));
});

test(`${J} #3 opens the Synthetic tab: no call is built and the market feed notice is shown`, async ({ page }) => {
  const wallet = await openSection(page, 'Issue');
  await main(page).getByRole('tab', { name: 'Synthetic' }).click();
  await expect(main(page).getByRole('note').filter({ hasText: 'Synthetic' })).toContainText('feed.market');
  await expect(main(page).getByRole('button', { name: 'Review' })).toBeDisabled();
  expect(wallet.sends).toHaveLength(0);
});

test(`${J} #5 opens a fundraising campaign with milestone shares that sum to 10000: a missed goal refunds in full; bad shares or a zero goal refused`, async ({
  page,
}) => {
  const wallet = await openSection(page, 'Raise');
  await main(page).getByRole('button', { name: 'New campaign' }).click();
  const form = main(page).getByRole('form', { name: 'New campaign' });
  await form.getByRole('textbox', { name: /^Goal in TEST Token A/ }).fill('0');
  const milestones = form.getByRole('group', { name: 'Milestones' });
  await milestones
    .getByRole('textbox', { name: /^Share \(basis points\)/ })
    .first()
    .fill('9999');
  await form.getByRole('button', { name: 'Review' }).click();
  await expect(form.getByRole('alert')).toContainText('The goal must be above 0');
  await expect(form.getByRole('alert')).toContainText('Milestone shares must add up to 10000');
  expect(wallet.sends).toHaveLength(0);
  // A TEST campaign of the stack that missed its goal: every investor's refund equals what they put in.
  const missed = main(page).getByRole('region', { name: 'TEST missed campaign' });
  await expect(bodyRows(tableIn(missed, 'Investors'))).not.toHaveCount(0);
  for (const row of await bodyRows(tableIn(missed, 'Investors')).all())
    expect(oneAmount(await row.getByTestId('refunded').innerText())).toBe(oneAmount(await row.getByTestId('invested').innerText()));
});

test(`${J} #6 releases the first milestone after approval: only tranche 1 is released; an approval below the threshold refused`, async ({
  page,
}) => {
  await openSection(page, 'Raise', seededWallet);
  const campaign = main(page).getByRole('region', { name: 'TEST funded campaign' });
  const tranches = tableIn(campaign, 'Tranches');
  await bodyRows(tranches).filter({ hasText: 'Tranche 2' }).getByRole('button', { name: 'Release' }).click();
  await expect(campaign.getByRole('alert')).toContainText('Not approved: 1 of 2 approvals');
  await bodyRows(tranches).filter({ hasText: 'Tranche 1' }).getByRole('button', { name: 'Release' }).click();
  await sign(page);
  await expect(bodyRows(tranches).filter({ hasText: 'Released' })).toHaveCount(1, { timeout: 60_000 });
  await expect(bodyRows(tranches).filter({ hasText: 'Tranche 1' })).toContainText('Released');
});

test(`${J} #7 deposits stables into the treasury vault: with the programme reference not recorded the card says so and nothing is sent`, async ({
  page,
}) => {
  const wallet = await openSection(page, 'Treasury vault');
  const vault = main(page).getByRole('region', { name: 'Treasury vault' });
  // The programme reference hash is an owner decision and blank on the stack: the deposit is refused before signing.
  await expect(vault.getByRole('note')).toContainText('The programme reference is not recorded. owner.decision');
  await vault.getByRole('textbox', { name: /^Deposit in TEST Token A/ }).fill('100');
  await expect(vault.getByRole('button', { name: 'Review' })).toBeDisabled();
  expect(wallet.sends).toHaveLength(0);
});

test(`${J} #8 redeems all shares after a 5 percent gain (TEST): the deposit plus its pro-rata gain; no one redeems more than their share`, async ({
  page,
}) => {
  await openSection(page, 'Treasury vault', seededWallet);
  const vault = main(page).getByRole('region', { name: 'TEST vault with a 5% gain' });
  const deposited = oneAmount(await vault.getByTestId('my-deposit').innerText());
  await expect(vault.getByTestId('redeemable')).toBeVisible();
  // Rounded down, as the vault rounds: the deposit plus 5 percent, never more.
  expect(oneAmount(await vault.getByTestId('redeemable').innerText())).toBe((deposited * 105n) / 100n);
  await vault.getByRole('textbox', { name: /^Redeem shares/ }).fill('all');
  await vault.getByRole('button', { name: 'Review' }).click();
  await sign(page);
  await expect(vault.getByTestId('my-deposit')).toHaveText(/^Your deposit: 0 /, { timeout: 60_000 });
});
