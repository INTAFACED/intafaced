import { test, expect } from '@playwright/test';
import { TOKEN_A, UNBUILT, connectWallet, dexRun, walletSection } from './dex.mjs';
import { toUnits } from './stack.mjs';
import { bodyRows, tableIn } from './tables.mjs';

// J-dex-protocol-15, in the running app (docs/roadmap/journeys.json): earn by supplying, turn on auto-earn and
// understand the limits. One test per step, titled "J-dex-protocol-15 #<n>", run in order with one TEST wallet holding
// TEST token A (the TEST stable token here). Supply goes into an isolated market for supplier shares; a supply then
// withdraw never returns more than was put in without interest; nothing posts to the ledger. owner.decision shows for
// the shared liquidity layer and the timelock until the owner decides; rail.crypto while the node is absent.
// Every step is written; none is built yet, so each fails at its first missing part, quickly (UNBUILT):
// - the Web3 side has no earn room (/dex/earn): no supply or withdraw, expanding withdraw limit, debt ceiling,
//   auto-earn, looping, flash-loan docs or parameter timelock (D-lend-earn-01, -05, -06);
// - the stack publishes no market and has no TEST chain, so nothing a step signs can mine;
// - #9's first half (a pending change with its delay) needs an owner timelock, which the stack leaves blank; the step
//   checks the blank case.
const J = 'J-dex-protocol-15';
const dex = dexRun(J);
const MARKET = 'TEST Token A';

test.describe.configure({ mode: 'default' });

const market = (page) => page.getByRole('main').getByRole('region', { name: `Supply ${MARKET}` });
const shares = (page) => market(page).getByTestId('your-shares');

/** Opens the earn room's TEST market with the run's wallet connected. */
async function openEarn(page) {
  const wallet = await connectWallet(page, dex, { tokens: [TOKEN_A] });
  await page.goto('/dex/earn');
  await expect(market(page)).toBeVisible(UNBUILT);
  return wallet;
}

/** Signs whatever the open sheet asks for. */
async function sign(page) {
  await page.getByRole('dialog', { name: 'Check before you sign' }).getByRole('button', { name: 'Continue in wallet' }).click();
}

/** Supplies or withdraws `amount` in the TEST market's form. */
async function move(page, action, amount) {
  const form = market(page).getByRole('form', { name: action });
  await form.getByRole('textbox', { name: /^Amount/ }).fill(amount);
  await form.getByRole('button', { name: 'Review' }).click();
  return form;
}

test(`${J} starts: a TEST wallet holding TEST stable tokens`, async ({ page }) => {
  dex.start();
  await connectWallet(page, dex, { tokens: [TOKEN_A] });
});

test(`${J} #1 supplies 1000 TEST: supplier shares and the current rate; the first depositor cannot inflate the share price`, async ({
  page,
}) => {
  await openEarn(page);
  await expect(market(page).getByTestId('supply-rate')).toHaveText(/^[\d.]+ ?%$/);
  await move(page, 'Supply', '1000');
  await sign(page);
  await expect(shares(page)).toHaveText(/^[\d,.]+ shares$/, { timeout: 60_000 });
  // A market's first deposit mints dead shares, so a donation cannot move the share price.
  await expect(market(page).getByRole('note')).toContainText('The first deposit locks a small amount of shares');
  dex.run.write({ supplied: '1000' });
});

test(`${J} #2 withdraws the same shares with no interest: at most 1000 comes back; supplier assets equal cash plus debt minus reserve`, async ({
  page,
}) => {
  await openEarn(page);
  const form = await move(page, 'Withdraw', '1000');
  const back = await form.getByTestId('you-receive').innerText();
  expect(toUnits(back.replace(/[^\d.]/g, '')) <= toUnits(dex.run.read().supplied ?? '1000')).toBe(true);
  await sign(page);
  await expect(shares(page)).toHaveText(/^0(\.0+)? shares$/, { timeout: 60_000 });
  // Each book line is one exact amount in TEST Token A, at full precision; the identity holds once the withdraw lands.
  const books = market(page).getByRole('region', { name: 'Market books' });
  const read = async (id) => {
    const text = await books.getByTestId(id).innerText();
    const amount = text.match(/^([\d,]+(?:\.\d+)?) TEST Token A$/)?.[1];
    expect(amount, `${id}: ${text}`).toBeTruthy();
    return toUnits(amount.replaceAll(',', ''));
  };
  await expect(async () => {
    expect(await read('supplier-assets')).toBe((await read('cash')) + (await read('debt')) - (await read('reserve')));
  }).toPass({ timeout: 30_000 });
});

test(`${J} #3 tries to withdraw the whole cash at once on a market with an expanding limit: the part above the available amount is refused and the room shows when the rest frees up`, async ({
  page,
}) => {
  await openEarn(page);
  await move(page, 'Supply', '1000');
  await sign(page);
  const form = await move(page, 'Withdraw', '1000');
  await expect(form.getByRole('alert')).toContainText(/You can withdraw [\d,.]+ now/);
  await expect(form.getByTestId('limit-expands')).toHaveText(/^The rest is available from \d{2}:\d{2}/);
});

test(`${J} #4 retries later: the expanded limit lets the rest through`, async ({ page }) => {
  test.setTimeout(240_000);
  await openEarn(page);
  // The TEST market's limit expands within a few minutes; the retry goes through then.
  await expect(async () => {
    const form = await move(page, 'Withdraw', '1000');
    await expect(form.getByRole('alert')).toHaveCount(0, { timeout: 2_000 });
  }).toPass({ timeout: 200_000 });
  await sign(page);
});

test(`${J} #5 reaches the debt ceiling as a borrower: borrow refuses with the ceiling named`, async ({ page }) => {
  await openEarn(page);
  await page.goto('/dex/lend');
  const markets = tableIn(page.getByRole('main'), 'TEST markets');
  await bodyRows(markets).filter({ hasText: 'TEST ceiling' }).getByRole('link').click(UNBUILT);
  await page.getByRole('main').getByRole('button', { name: 'Borrow' }).click();
  const borrow = page.getByRole('form', { name: 'Borrow' });
  await borrow.getByRole('textbox', { name: /^Amount/ }).fill('1000000');
  await borrow.getByRole('button', { name: 'Review' }).click();
  await expect(borrow.getByRole('alert')).toContainText(/debt ceiling of [\d,.]+/);
});

test(`${J} #6 turns on auto-earn with a threshold of 100 TEST: a wallet balance of 130 supplies 30 by the key; any other call from the key is refused`, async ({
  page,
}) => {
  await connectWallet(page, dex, { tokens: [TOKEN_A] });
  await walletSection(page, 'Accounts');
  await page.getByRole('switch', { name: 'Auto-earn' }).click(UNBUILT);
  await page.getByRole('textbox', { name: /^Keep in the wallet/ }).fill('100');
  await sign(page);
  const runs = tableIn(page.getByRole('main'), 'Auto-earn runs');
  await expect(bodyRows(runs).filter({ hasText: /Supplied 30(\.0+)? TEST Token A/ })).toHaveCount(1, { timeout: 120_000 });
  await expect(page.getByRole('region', { name: 'Auto-earn key' })).toContainText('Any other call from this key is refused.');
});

test(`${J} #7 sets up looping to 3 times on a market that allows 2.5: refused before sending with the maximum; a failed swap leg reverts the whole transaction`, async ({
  page,
}) => {
  const wallet = await openEarn(page);
  await market(page).getByRole('button', { name: 'Loop' }).click();
  const loop = page.getByRole('form', { name: 'Looping strategy' });
  await loop.getByRole('spinbutton', { name: /^Times/ }).fill('3');
  await loop.getByRole('button', { name: 'Review' }).click();
  await expect(loop.getByRole('alert')).toContainText('This market allows at most 2.5 times');
  expect(wallet.sends).toHaveLength(0);
  await expect(loop.getByRole('note')).toContainText('If any swap leg fails, the whole transaction reverts.');
});

test(`${J} #8 reads the flash-loan docs: a call that must repay in the same transaction, the fee shown, and the rate-unset notice when blank`, async ({
  page,
}) => {
  await openEarn(page);
  await market(page).getByRole('link', { name: 'Flash loans' }).click();
  const docs = page.getByRole('main').getByRole('region', { name: 'Flash loans' });
  await expect(docs).toContainText('Must be repaid in the same transaction');
  // The owner's flash-loan fee is blank on the stack: the docs say so rather than show a number.
  await expect(docs.getByTestId('flash-fee')).toHaveText('Flash-loan fee not set');
});

test(`${J} #9 reads the parameter timelock: a pending change shows its delay and cannot apply early; with the timelock blank the typed refusal`, async ({
  page,
}) => {
  await openEarn(page);
  await market(page).getByRole('link', { name: 'Parameter changes' }).click();
  const changes = page.getByRole('main').getByRole('region', { name: 'Parameter changes' });
  await expect(changes).toContainText('dex.lend.timelock_unset');
  await expect(changes.getByRole('button', { name: 'Apply now' })).toHaveCount(0);
});
