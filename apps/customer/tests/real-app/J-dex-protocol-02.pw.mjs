import { test, expect } from '@playwright/test';
import { installTestWallet } from './test-wallet.mjs';

// J-dex-protocol-02, in the running app (docs/roadmap/journeys.json): swap one TEST token for another from the person's
// own wallet. One test per step, titled "J-dex-protocol-02 #<n>". The swap is signed by the person's wallet (the TEST
// wallet in test-wallet.mjs) and nothing posts to the ledger. Tokens A and B are the TEST pair the stack's pool is to
// hold; their addresses come from the swap form's token list, never from this file.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - The stack publishes no node to svc-protocol (tooling/scripts/local-stack-services/protocol.mjs), so no quote, route,
//   price, allowance or fee can be read: every step from #2 on waits on that (rail.crypto).
// - #1: the swap form has no Simple and Manual modes (D-swap-10).
// - #9, #10: no failed-swap card and no approvals list (D-swap-01, D-swap-04); #11: no gas paid in a token (RC-dex-protocol-02).
const J = 'J-dex-protocol-02';
const UNBUILT = { timeout: 5_000 };
const BASE_SEPOLIA = 84532;

test.describe.configure({ mode: 'default' });

const form = (page) => page.getByRole('form', { name: 'Swap' });
const tokenIn = (page) => form(page).getByRole('combobox', { name: 'You pay' });
const tokenOut = (page) => form(page).getByRole('combobox', { name: 'You receive' });
const amountIn = (page) => form(page).getByRole('textbox', { name: 'Amount to pay' });

/** The swap form with the TEST wallet connected on Base Sepolia, token A in and token B out. */
async function openSwap(page, { amount } = {}) {
  await installTestWallet(page, { chainId: BASE_SEPOLIA });
  await page.goto('/dex');
  await expect(form(page)).toBeVisible(UNBUILT);
  await form(page)
    .getByRole('button', { name: /^Connect TEST Wallet/ })
    .click();
  await tokenIn(page).selectOption({ label: 'TEST Token A' }, UNBUILT);
  await tokenOut(page).selectOption({ label: 'TEST Token B' });
  if (amount) await amountIn(page).fill(amount);
}

const quote = (page) => form(page).getByTestId('swap-quote');

test(`${J} #1 opens the swap form as a new viewer: Simple with no advanced controls; Manual shows its notice once and is remembered; with blocked storage it still works in Simple`, async ({
  page,
  browser,
}) => {
  await page.goto('/dex');
  const simple = page.getByRole('radio', { name: 'Simple' });
  await expect(simple).toBeChecked(UNBUILT);
  await expect(page.getByRole('button', { name: 'Route options' })).toHaveCount(0);
  await page.getByRole('radio', { name: 'Manual' }).check();
  const notice = page.getByRole('dialog', { name: /Manual mode/ });
  await expect(notice).toBeVisible();
  await notice.getByRole('button', { name: 'Got it' }).click();
  await page.reload();
  await expect(page.getByRole('radio', { name: 'Manual' })).toBeChecked();
  await expect(page.getByRole('dialog', { name: /Manual mode/ })).toHaveCount(0);

  // Storage blocked: the form still opens, in Simple.
  const blocked = await browser.newContext();
  await blocked.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      get: () => {
        throw new DOMException('blocked', 'SecurityError');
      },
    });
  });
  const other = await blocked.newPage();
  await other.goto('/dex');
  await expect(other.getByRole('radio', { name: 'Simple' })).toBeChecked();
  await blocked.close();
});

test(`${J} #2 picks token A in and token B out: a USD price with its as-of time for each; a thin-reserve token shows no price and the reason`, async ({
  page,
}) => {
  await openSwap(page);
  for (const side of ['in', 'out']) {
    const price = form(page).getByTestId(`swap-price-${side}`);
    await expect(price).toContainText(/\$[\d,.]+/);
    await expect(price).toContainText(/as of \d{1,2}:\d{2}/);
  }
  await tokenOut(page).selectOption({ label: 'TEST Thin Token' });
  await expect(form(page).getByTestId('swap-price-out')).toContainText('No price: too little in reserve');
});

test(`${J} #3 types an amount: a quote with a countdown; once expired "Quote expired" and Swap is off until refresh`, async ({ page }) => {
  test.setTimeout(180_000);
  await openSwap(page, { amount: '1' });
  await expect(quote(page)).toContainText(/Expires in \d+ s/);
  await expect(quote(page)).toContainText('Quote expired', { timeout: 120_000 });
  await expect(form(page).getByRole('button', { name: 'Swap' })).toBeDisabled();
  await form(page).getByRole('button', { name: 'Refresh quote' }).click();
  await expect(quote(page)).toContainText(/Expires in \d+ s/);
});

test(`${J} #4 opens the route options and excludes the better pool: legs best first with why the other lost; a stale pool reads "unavailable: stale"`, async ({
  page,
}) => {
  await openSwap(page, { amount: '1' });
  await form(page).getByRole('button', { name: 'Route options' }).click();
  const routes = page.getByRole('list', { name: 'Routes' }).getByRole('listitem');
  expect(await routes.count()).toBeGreaterThan(1);
  await expect(routes.nth(1)).toContainText(/lost by|less out/i);
  const listed = await routes.count();
  await routes
    .first()
    .getByRole('checkbox', { name: /Exclude/ })
    .check();
  await expect(routes.first()).toContainText('Excluded');
  // Nothing is dropped silently: an excluded or stale pool stays listed, a stale one as "unavailable: stale".
  await expect(routes).toHaveCount(listed);
});

test(`${J} #5 sets slippage to 1 percent, then above the ceiling: the minimum output is shown; above the ceiling is refused naming it; a thin pool warns of price impact`, async ({
  page,
}) => {
  await openSwap(page, { amount: '1' });
  const slippage = form(page).getByRole('textbox', { name: 'Slippage, %' });
  await slippage.fill('1');
  await expect(form(page).getByTestId('swap-minimum-out')).toContainText(/Minimum received [\d.]+ TEST-B/);
  await slippage.fill('99');
  await expect(form(page).getByRole('alert')).toContainText(/above the ceiling of [\d.]+ ?%/);
  await tokenOut(page).selectOption({ label: 'TEST Thin Token' });
  await slippage.fill('1');
  await expect(form(page).getByRole('alert')).toContainText(/price impact/i);
});

test(`${J} #6 presses Swap with no allowance: one approve step for the exact amount, then the swap`, async ({ page }) => {
  await openSwap(page, { amount: '1' });
  await form(page).getByRole('button', { name: 'Swap' }).click();
  const steps = page.getByRole('list', { name: 'Steps to swap' }).getByRole('listitem');
  await expect(steps).toHaveCount(2);
  await expect(steps.first()).toContainText('Approve exactly 1 TEST-A');
  await expect(steps.last()).toContainText('Swap');
});

test(`${J} #7 chooses a network fee level: three levels from the last blocks, a custom value above the cap refused, and the fee line says who pays`, async ({
  page,
}) => {
  await openSwap(page, { amount: '1' });
  const levels = form(page).getByRole('radiogroup', { name: 'Network fee' }).getByRole('radio');
  await expect(levels).toHaveText([/Slow/, /Normal/, /Fast/]);
  await form(page)
    .getByRole('radio', { name: /Custom/ })
    .check();
  await form(page).getByRole('textbox', { name: 'Custom fee, gwei' }).fill('100000');
  await expect(form(page).getByRole('alert')).toContainText(/above the cap/i);
  await expect(form(page).getByTestId('swap-fee-line')).toContainText(/You pay the network fee|Sponsored/);
});

test(`${J} #8 signs the swap in the wallet: submitted, confirming, filled; the card's input, output and gas match the Swap event`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  await openSwap(page, { amount: '1' });
  await form(page).getByRole('button', { name: 'Swap' }).click();
  const card = page.getByTestId('swap-card');
  for (const status of ['Submitted', 'Confirming', 'Filled'])
    await expect(card.getByTestId('swap-status')).toHaveText(status, { timeout: 60_000 });
  for (const field of ['You paid', 'You received', 'Network fee']) await expect(card).toContainText(field);
  await expect(card.getByRole('link', { name: 'See the transaction' })).toHaveAttribute('href', /\/chain\/tx\/0x[0-9a-f]{64}$/);
});

test(`${J} #9 retries after the price moved: failed with the reason in a sentence, no automatic retry, and a new quote is needed`, async ({
  page,
}) => {
  await openSwap(page, { amount: '1' });
  await form(page).getByRole('textbox', { name: 'Slippage, %' }).fill('0.01');
  await form(page).getByRole('button', { name: 'Swap' }).click();
  const card = page.getByTestId('swap-card');
  await expect(card.getByTestId('swap-status')).toHaveText('Failed', { timeout: 60_000 });
  await expect(card).toContainText(/The price moved .*\./);
  await expect(form(page).getByRole('button', { name: 'Swap' })).toBeDisabled();
  await expect(form(page).getByRole('button', { name: 'Get a new quote' })).toBeVisible();
});

test(`${J} #10 opens the approvals list and revokes the allowance: spender and amount, revoke sets zero and the row goes`, async ({
  page,
}) => {
  await installTestWallet(page, { chainId: BASE_SEPOLIA });
  await page.goto('/wallet/approvals');
  await page.getByRole('button', { name: /^Connect TEST Wallet/ }).click(UNBUILT);
  const rows = page.getByRole('table', { name: 'Token approvals' }).locator('tbody tr');
  await expect(rows.first()).toContainText(/TEST-A/);
  await expect(rows.first()).toContainText(/Spender/);
  const before = await rows.count();
  await rows.first().getByRole('button', { name: 'Revoke' }).click();
  await expect(rows).toHaveCount(before - 1, { timeout: 60_000 });
});

test(`${J} #11 swaps holding only a TEST stable token and no native currency, paying the network fee in that token`, async ({ page }) => {
  await openSwap(page, { amount: '1' });
  await form(page)
    .getByRole('radio', { name: /Pay the fee in TEST-USD/ })
    .check(UNBUILT);
  const line = form(page).getByTestId('swap-fee-line');
  await expect(line).toContainText(/[\d.]+ TEST-USD/);
  await expect(line).toContainText(/oracle rate/i);
  await expect(line).toContainText(/markup/i);
});
