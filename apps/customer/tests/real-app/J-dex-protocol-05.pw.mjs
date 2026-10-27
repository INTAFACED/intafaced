import { test, expect } from '@playwright/test';
import { TOKEN_A, UNBUILT, connectWallet, dexRun } from './dex.mjs';
import { fundedTrader, signIn } from './desk.mjs';

// J-dex-protocol-05, in the running app (docs/roadmap/journeys.json): move value between the exchange, the wallet and
// another chain. One test per step, titled "J-dex-protocol-05 #<n>", run in order with one verified TEST account holding
// TEST USDT and one TEST wallet on Base Sepolia. Exchange to wallet goes through the custodial withdraw path with step-up;
// the bridge is non-custodial and posts nothing to the ledger. rail.crypto shows while the deposit address service is
// absent; audit.external stays on any mainnet leg.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - the exchange Deposit page (/uc/recharge) has no network to choose while crypto custody is absent, and the stack has
//   no TEST chain to deposit from, so #2 has no incoming row (D-bridge-chain-01);
// - Withdraw does not fill the destination from the wallet (D-bridge-chain-02), and the bank ramps have no "Buy to
//   wallet" route;
// - /protocol/rails has no route table, burn, attestation or mint tracking (D-bridge-chain-03), and no cross-chain
//   review sheet (RC-dex-protocol-04);
// - /dex/venue has no deposit or withdraw of base, and there is no asset link review or contract-read docs
//   (D-bridge-chain-04).
const J = 'J-dex-protocol-05';
const dex = dexRun(`${J}-wallet`);
const account = dexRun(J);
// A contract address on the TEST chain: withdrawing to it warns and needs a tick.
const CONTRACT = '0x0000000000000000000000000000000000c0ffee';
// Partner and vendor names user-facing copy must never carry (pnpm scan:brand keeps the full list).
const BANNED = /fireblocks|bitgo|circle|coinbase|chainalysis|elliptic|wormhole|layerzero/i;

test.describe.configure({ mode: 'default' });

/** The run's verified, funded TEST account, signed in. */
async function person(page) {
  const who = account.run.read().who;
  expect(who, 'the start step made the account').toBeTruthy();
  await signIn(page, who);
  return who;
}

const rails = (page) => page.getByRole('region', { name: 'Bridge routes' });
const transfers = (page) => page.getByRole('region', { name: 'Bridge transfers' }).getByRole('table');

/** Opens /protocol/rails with the run's wallet connected. */
async function openRails(page) {
  const wallet = await connectWallet(page, dex, { tokens: [TOKEN_A] });
  await page.goto('/protocol/rails');
  await expect(rails(page)).toBeVisible(UNBUILT);
  return wallet;
}

test(`${J} starts: a verified exchange account with TEST USDT and a connected TEST wallet`, async ({ page }) => {
  test.setTimeout(240_000);
  const who = await fundedTrader(page, 'dex05', '50');
  account.run.reset({ who });
  dex.start();
  await connectWallet(page, dex, { tokens: [TOKEN_A] });
});

test(`${J} #1 opens the exchange Deposit page for a chain: minimums and arrival terms in plain words, the address panel needs a crypto network connection, no partner names`, async ({
  page,
}) => {
  test.setTimeout(120_000);
  await person(page);
  await page.goto('/uc/recharge');
  await page.mouse.move(0, 600);
  // The deposit asset chooser (its hint is part of its name; the records filter below is called Asset alone). With no
  // crypto custody it has nothing to choose yet.
  await page.getByRole('combobox', { name: /^Asset \S/ }).selectOption({ label: 'USDT' }, UNBUILT);
  // The chain is chosen next; its minimum and arrival terms are then written out for that chain.
  await page.getByRole('combobox', { name: /^Network/ }).selectOption({ label: 'Base Sepolia' }, UNBUILT);
  await expect(page.getByTestId('deposit-terms')).toContainText(/Deposits under [\d.]+ USDT are not credited/);
  await expect(page.getByTestId('deposit-terms')).toContainText(/Arrives after \d+ confirmations/);
  await expect(page.getByText('Deposit addresses are not available', { exact: true })).toBeVisible();
  await expect(page.getByText(/rail\.crypto/)).toBeVisible();
  expect(await page.locator('body').innerText()).not.toMatch(BANNED);
});

test(`${J} #2 watches a TEST deposit arrive: "Confirming 1 of N" with an explorer link, or the hash alone; below the minimum the row says it is not credited`, async ({
  page,
}) => {
  test.setTimeout(120_000);
  await person(page);
  await page.goto('/uc/recharge');
  const incoming = page.getByRole('region', { name: 'On its way' }).getByRole('table');
  const row = incoming.getByRole('row').filter({ hasText: /Confirming 1 of \d+/ });
  await expect(row).toHaveCount(1, UNBUILT);
  await expect(row.getByRole('link', { name: /^View on explorer/ }).or(row.getByText(/^0x[0-9a-f]{64}$/))).toBeVisible();
  await expect(incoming.getByRole('row').filter({ hasText: 'Below the minimum: not credited' })).toHaveCount(1);
});

test(`${J} #3 opens Withdraw with to=wallet: destination and network filled and read-only until Edit; a contract destination warns and needs a tick`, async ({
  page,
}) => {
  test.setTimeout(120_000);
  await person(page);
  const wallet = await connectWallet(page, dex, { tokens: [TOKEN_A] });
  await page.goto('/uc/withdraw?to=wallet');
  const form = page.getByTestId('withdraw-form');
  const destination = form.getByRole('textbox', { name: /^Your wallet/ });
  await expect(destination).toHaveValue(wallet.address, UNBUILT);
  await expect(destination).not.toBeEditable();
  await expect(form.getByRole('combobox', { name: /^Network/ })).toHaveValue(/base-sepolia/i);
  await form.getByRole('button', { name: 'Edit' }).click();
  await destination.fill(CONTRACT);
  await expect(form.getByRole('alert')).toContainText('This address is a contract');
  const tick = form.getByRole('checkbox', { name: /^I checked this contract can receive/ });
  await expect(form.getByRole('button', { name: /^Review/ })).toBeDisabled();
  await tick.check();
  await expect(form.getByRole('button', { name: /^Review/ })).toBeEnabled();
});

test(`${J} #4 opens Buy to wallet in the bank ramps: the purchase lands in the wallet address, not the exchange balance`, async ({
  page,
}) => {
  test.setTimeout(120_000);
  await person(page);
  const wallet = await connectWallet(page, dex, { tokens: [TOKEN_A] });
  await page.goto('/bank/ramps/new');
  const deliver = page.getByRole('radiogroup', { name: 'Deliver to' });
  await deliver.getByRole('radio', { name: 'My wallet' }).check(UNBUILT);
  await expect(page.getByTestId('ramp-destination')).toContainText(wallet.address);
  await expect(page.getByTestId('ramp-destination')).not.toContainText('Exchange balance');
});

test(`${J} #5 opens the rails room with the route table blank: the full layout, the blocker for unset routes with its owner-decision label, no route offered`, async ({
  page,
}) => {
  await openRails(page);
  const table = rails(page).getByRole('table');
  await expect(table.getByRole('columnheader', { name: 'From' })).toBeVisible();
  await expect(table.getByRole('columnheader', { name: 'To' })).toBeVisible();
  await expect(rails(page)).toContainText('No bridge routes are set. Routes are an owner decision.');
  await expect(rails(page).getByText('Owner decision', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start a transfer' })).toBeDisabled();
});

test(`${J} #6 builds a burn on a TEST route and signs it: burn submitted, then mint ready when the attestation arrives, then minted after the mint is signed`, async ({
  page,
}) => {
  await openRails(page);
  await page.getByRole('button', { name: 'Start a transfer' }).click(UNBUILT);
  const form = page.getByRole('form', { name: 'Bridge transfer' });
  await form.getByRole('combobox', { name: 'From' }).selectOption({ label: 'Base Sepolia' });
  await form.getByRole('combobox', { name: 'To' }).selectOption({ label: 'TEST chain' });
  await form.getByRole('combobox', { name: 'Token' }).selectOption({ label: 'USDC' });
  await form.getByRole('textbox', { name: /^Amount/ }).fill('1');
  await form.getByRole('button', { name: 'Review' }).click();
  await page.getByRole('button', { name: 'Continue in wallet' }).click();
  const row = transfers(page).getByRole('row').filter({ hasText: '1 USDC' });
  await expect(row).toContainText('Burn submitted');
  await expect(row).toContainText('Mint ready', { timeout: 120_000 });
  await row.getByRole('button', { name: 'Sign the mint' }).click();
  await page.getByRole('button', { name: 'Continue in wallet' }).click();
  await expect(row).toContainText('Minted', { timeout: 60_000 });
  dex.run.write({ bridged: true });
});

test(`${J} #7 closes the browser after the burn and returns: the same row, still tracked; a stored intent resumes, never a second burn`, async ({
  browser,
}) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await openRails(page);
    expect(dex.run.read().bridged, 'the burn step ran').toBe(true);
    await expect(transfers(page).getByRole('row').filter({ hasText: '1 USDC' })).toHaveCount(1);
    await expect(transfers(page).getByRole('row').filter({ hasText: 'Burn submitted' })).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test(`${J} #8 opens the review sheet before a cross-chain swap: provider, slippage, network fee, duration and receive; an expired quote is refused; a missing destination gas notice`, async ({
  page,
}) => {
  await connectWallet(page, dex, { tokens: [TOKEN_A] });
  await page.goto('/dex');
  const swap = page.getByRole('form', { name: 'Swap' });
  await swap.getByRole('combobox', { name: 'Destination network' }).selectOption({ label: 'TEST chain' }, UNBUILT);
  await swap.getByRole('textbox', { name: /^Amount you pay/ }).fill('1');
  await swap.getByRole('button', { name: 'Review' }).click();
  const sheet = page.getByRole('dialog', { name: 'Review the cross-chain swap' });
  for (const term of ['Provider', 'Slippage', 'Network fee', 'Estimated time', 'You receive'])
    await expect(sheet.getByRole('term').filter({ hasText: term })).toBeVisible();
  await expect(sheet.getByRole('note')).toContainText('You have no gas on the destination network');
  await page.clock.install();
  await page.clock.fastForward('05:00');
  await sheet.getByRole('button', { name: 'Continue in wallet' }).click();
  await expect(sheet.getByRole('alert')).toContainText('This quote expired. Get a fresh one.');
});

test(`${J} #9 deposits 10 TEST base to the trading venue and withdraws more than is free: the unsigned call is shown and nothing is sent; above the free amount refused naming it`, async ({
  page,
}) => {
  const wallet = await connectWallet(page, dex, { tokens: [TOKEN_A] });
  await page.goto('/dex/venue');
  const funds = page.getByRole('form', { name: 'Venue funds' });
  await funds.getByRole('radio', { name: 'Deposit' }).check(UNBUILT);
  await funds.getByRole('textbox', { name: /^Amount/ }).fill('10');
  await funds.getByRole('button', { name: 'Build the call' }).click();
  const call = page.getByRole('region', { name: 'Unsigned call' });
  await expect(call).toContainText('10');
  await expect(call).toContainText('Base Sepolia');
  expect(wallet.requests.filter((r) => r.method === 'eth_sendTransaction')).toHaveLength(0);
  await funds.getByRole('radio', { name: 'Withdraw' }).check();
  await funds.getByRole('textbox', { name: /^Amount/ }).fill('1000000');
  await funds.getByRole('button', { name: 'Build the call' }).click();
  await expect(funds.getByRole('alert')).toContainText(/more than is free \([\d.]+ free\)/);
});

test(`${J} #10 requests an asset link review and opens the contract-read docs: the review states decimals and the verdict; the docs list read-only calls with examples`, async ({
  page,
}) => {
  await connectWallet(page, dex, { tokens: [TOKEN_A] });
  await page.goto('/protocol/contracts');
  await page.getByRole('button', { name: 'Request an asset link review' }).click(UNBUILT);
  const review = page.getByRole('form', { name: 'Asset link review' });
  await review.getByRole('textbox', { name: /^Token address/ }).fill(TOKEN_A.address);
  await review.getByRole('button', { name: 'Request review' }).click();
  const result = page.getByRole('region', { name: 'Review result' });
  await expect(result).toContainText(`Decimals ${TOKEN_A.decimals}`);
  await expect(result).toContainText(/Verdict: (linked|not linked)/);
  await page.getByRole('link', { name: 'Contract-read docs' }).click();
  const calls = page.getByRole('region', { name: 'Read-only calls' });
  await expect(calls.getByRole('heading')).not.toHaveCount(0);
  await expect(calls.getByRole('code').first()).toBeVisible();
});
