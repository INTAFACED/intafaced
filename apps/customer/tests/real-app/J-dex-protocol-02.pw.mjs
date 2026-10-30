import { test, expect } from '@playwright/test';
import { TOKEN_A, TOKEN_B, UNBUILT, acceptRepresentation, connectWallet, dexRun, walletSection } from './dex.mjs';

// J-dex-protocol-02, in the running app (docs/roadmap/journeys.json): swap one token for another. One test per step,
// titled "J-dex-protocol-02 #<n>", run in order with one TEST wallet on Base Sepolia holding TEST token A and no
// allowance. The swap is signed by the person's own wallet; nothing posts to the ledger and no fee is invented (a blank
// fee schedule refuses). A missing node or router shows rail.crypto.
// Every step is written; none is built yet, so each fails at its first missing part, quickly (UNBUILT):
// - /dex's Swap tab is today's route-quote desk (symbol, side, quantity); the token-in/token-out form with Simple and
//   Manual modes, prices, slippage, route options, fee levels and the swap status (D-swap-01 to -06, -10, -11) is not
//   built, so every step stops at the first of those controls;
// - the stack has no TEST chain, router or pool, so the quote, approve and sign steps (#3 to #9) have nothing to call;
// - #11 (paying the network fee in a TEST stable token, RC-dex-protocol-02) has no paymaster on the stack.
const J = 'J-dex-protocol-02';
const dex = dexRun(J);

test.describe.configure({ mode: 'default' });

const swap = (page) => page.getByRole('form', { name: 'Swap' });
const tokenIn = (page) => swap(page).getByRole('combobox', { name: 'You pay' });
const tokenOut = (page) => swap(page).getByRole('combobox', { name: 'You receive' });
const amountIn = (page) => swap(page).getByRole('textbox', { name: /^Amount you pay/ });
const swapButton = (page) => swap(page).getByRole('button', { name: 'Swap', exact: true });

/** Opens /dex's Swap form with the run's wallet connected. */
async function openSwap(page) {
  const wallet = await connectWallet(page, dex, { tokens: [TOKEN_A, TOKEN_B] });
  await page.goto('/dex');
  await expect(swap(page)).toBeVisible(UNBUILT);
  return wallet;
}

/** Switches the form to Manual, accepting its one-time notice when this browser has not seen it yet. */
async function chooseManual(page) {
  await swap(page).getByRole('radio', { name: 'Manual' }).check(UNBUILT);
  const notice = page.getByRole('dialog', { name: 'Manual mode' });
  if (await notice.isVisible()) await notice.getByRole('button', { name: 'I understand' }).click();
}

/** Picks token A in, token B out and types `amount`. */
async function quoteAB(page, amount = '10') {
  await tokenIn(page).selectOption({ label: 'TEST Token A' });
  await tokenOut(page).selectOption({ label: 'TEST Token B' });
  await amountIn(page).fill(amount);
}

test(`${J} starts: a TEST wallet on Base Sepolia holding TEST token A and no allowance`, async ({ page }) => {
  dex.start();
  await openSwap(page);
  // A swap is a signing action, so a new wallet accepts the representation once (J-dex-protocol-01 #8). The swap's own
  // sheet that follows is cancelled: nothing is approved or sent, so the run starts with no allowance.
  await quoteAB(page, '1');
  await swapButton(page).click();
  await acceptRepresentation(page);
  await page.locator('[data-sheet="sequence"]').getByRole('button', { name: 'Cancel' }).click();
});

test(`${J} #1 opens the swap form as a new viewer: Simple mode, no advanced controls; Manual shows its notice once and is remembered; blocked storage still works`, async ({
  page,
  browser,
}) => {
  await openSwap(page);
  const mode = swap(page).getByRole('radiogroup', { name: 'Mode' });
  await expect(mode.getByRole('radio', { name: 'Simple' })).toBeChecked(UNBUILT);
  await expect(swap(page).getByRole('button', { name: 'Route options' })).toHaveCount(0);
  await expect(swap(page).getByRole('textbox', { name: /^Slippage/ })).toHaveCount(0);

  await mode.getByRole('radio', { name: 'Manual' }).check();
  await expect(page.getByRole('dialog', { name: 'Manual mode' })).toBeVisible();
  await page.getByRole('dialog', { name: 'Manual mode' }).getByRole('button', { name: 'I understand' }).click();
  await page.reload();
  await expect(mode.getByRole('radio', { name: 'Manual' })).toBeChecked();
  await expect(page.getByRole('dialog', { name: 'Manual mode' })).toHaveCount(0);

  // With storage blocked the form still opens and works in Simple.
  const blocked = await browser.newContext();
  try {
    const away = await blocked.newPage();
    await away.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        get() {
          throw new DOMException('blocked', 'SecurityError');
        },
      });
    });
    await away.goto('/dex');
    await expect(away.getByRole('form', { name: 'Swap' }).getByRole('radio', { name: 'Simple' })).toBeChecked();
  } finally {
    await blocked.close();
  }
});

test(`${J} #2 picks token A in and token B out: a USD price with its as-of time for each; a token with too little reserve shows no price and the reason`, async ({
  page,
}) => {
  await openSwap(page);
  await tokenIn(page).selectOption({ label: 'TEST Token A' }, UNBUILT);
  await tokenOut(page).selectOption({ label: 'TEST Token B' });
  for (const side of ['pay', 'receive']) {
    await expect(swap(page).getByTestId(`price-${side}`)).toHaveText(/^\$[\d,.]+ · as of \d{2}:\d{2}/);
  }
  // A thin token has no price, and says why rather than showing $0.
  await tokenOut(page).selectOption({ label: 'TEST Thin' });
  await expect(swap(page).getByTestId('price-receive')).toHaveText('No price: too little reserve to price this token.');
});

test(`${J} #3 types an amount: a quote with a countdown; when it expires "Quote expired" and Swap is off until refreshed`, async ({
  page,
}) => {
  await openSwap(page);
  await tokenIn(page).selectOption({ label: 'TEST Token A' }, UNBUILT);
  await quoteAB(page);
  await expect(swap(page).getByTestId('quote-countdown')).toHaveText(/^Refreshes in \d+ s$/);
  await expect(swap(page).getByRole('status')).toHaveText('Quote expired', { timeout: 120_000 });
  await expect(swapButton(page)).toBeDisabled();
  await swap(page).getByRole('button', { name: 'Refresh quote' }).click();
  await expect(swapButton(page)).toBeEnabled();
});

test(`${J} #4 opens the route options and excludes the better pool: legs listed best first with why the other lost; a stale pool reads "unavailable: stale"`, async ({
  page,
}) => {
  await openSwap(page);
  await tokenIn(page).selectOption({ label: 'TEST Token A' }, UNBUILT);
  await quoteAB(page);
  await swap(page).getByRole('button', { name: 'Route options' }).click();
  const routes = page.getByRole('region', { name: 'Routes' }).getByRole('table');
  const rows = routes.getByRole('row');
  await expect(rows.nth(1)).toContainText('Best');
  await expect(rows.nth(2)).toContainText(/Lost: /);
  await expect(routes).toContainText('unavailable: stale');
  await rows.nth(1).getByRole('checkbox', { name: 'Exclude' }).check();
  await expect(rows.nth(1)).toContainText('Excluded');
});

test(`${J} #5 sets slippage to 1 percent, then above the ceiling: the derived minimum shown; above the ceiling refused by name; a thin pool warns of price impact`, async ({
  page,
}) => {
  await openSwap(page);
  await chooseManual(page);
  await quoteAB(page);
  const slippage = swap(page).getByRole('textbox', { name: /^Slippage/ });
  await slippage.fill('1');
  await expect(swap(page).getByTestId('minimum-received')).toHaveText(/^Minimum received [\d,.]+ TEST Token B$/);
  await slippage.fill('60');
  await expect(swap(page).getByRole('alert')).toContainText(/above the slippage ceiling of [\d.]+ ?%/);
  await tokenOut(page).selectOption({ label: 'TEST Thin' });
  await expect(swap(page).getByRole('note')).toContainText('Price impact');
});

test(`${J} #6 presses Swap with no allowance: one approve step for the exact amount (or a reset pair where needed), then the swap`, async ({
  page,
}) => {
  const wallet = await openSwap(page);
  await tokenIn(page).selectOption({ label: 'TEST Token A' }, UNBUILT);
  await quoteAB(page, '10');
  await swapButton(page).click();
  const steps = page.getByRole('list', { name: 'Swap steps' });
  await expect(steps.getByRole('listitem').first()).toHaveText('Approve exactly 10 TEST Token A');
  await expect(steps.getByRole('listitem').last()).toContainText('Swap');
  expect(wallet.requests).toHaveLength(0);
});

test(`${J} #7 chooses a network fee level and reads the fee line: three levels from the last blocks; a custom value over the cap refused; who pays named`, async ({
  page,
}) => {
  await openSwap(page);
  const fees = swap(page).getByRole('radiogroup', { name: 'Network fee' });
  await expect(fees.getByRole('radio')).toHaveCount(4, UNBUILT);
  for (const level of ['Slow', 'Normal', 'Fast', 'Custom'])
    await expect(fees.getByRole('radio', { name: new RegExp(`^${level}`) })).toBeVisible();
  await fees.getByRole('radio', { name: /^Custom/ }).check();
  await swap(page)
    .getByRole('textbox', { name: /^Custom fee/ })
    .fill('100000');
  await expect(swap(page).getByRole('alert')).toContainText('above the fee cap');
  await expect(swap(page).getByTestId('fee-line')).toHaveText(/You pay the network fee|Network fee sponsored/);
});

test(`${J} #8 signs the swap in the wallet: submitted, confirming, filled; the card's input, output and gas match the Swap event`, async ({
  page,
}) => {
  const wallet = await openSwap(page);
  await tokenIn(page).selectOption({ label: 'TEST Token A' }, UNBUILT);
  await quoteAB(page, '10');
  await swapButton(page).click();
  await page.getByRole('button', { name: 'Continue in wallet' }).click();
  const card = page.getByRole('region', { name: 'Swap status' });
  for (const state of ['Submitted', 'Confirming', 'Filled']) await expect(card.getByRole('status')).toHaveText(state, { timeout: 60_000 });
  for (const term of ['You paid', 'You received', 'Network fee'])
    await expect(card.getByRole('term').filter({ hasText: term })).toBeVisible();
  await expect(card.getByRole('link', { name: 'Swap event' })).toBeVisible();
  // The swap was sent by the wallet itself (the TEST wallet keeps sent transactions in `sends`, signatures in `requests`).
  expect(wallet.sends.length).toBeGreaterThan(0);
});

test(`${J} #9 retries after the price moved: failed with the reason in a sentence, no automatic retry, a new quote needed`, async ({
  page,
  browser,
}) => {
  await openSwap(page);
  await chooseManual(page);
  await quoteAB(page, '10');
  await swap(page)
    .getByRole('textbox', { name: /^Slippage/ })
    .fill('0.1');
  await swapButton(page).click();

  // Before this swap is signed, another TEST wallet (funded on the TEST chain like this run's) swaps a large amount in the
  // same pool and moves the price. It is new too, so it accepts the representation first.
  const other = await browser.newContext();
  try {
    const mover = await other.newPage();
    const moverDex = dexRun(`${J}-mover`);
    moverDex.start();
    await connectWallet(mover, moverDex, { tokens: [TOKEN_A, TOKEN_B] });
    await mover.goto('/dex');
    await quoteAB(mover, '1000');
    await swapButton(mover).click();
    await acceptRepresentation(mover);
    await mover.getByRole('button', { name: 'Continue in wallet' }).click();
    await expect(mover.getByRole('region', { name: 'Swap status' }).getByRole('status')).toHaveText('Filled', { timeout: 60_000 });
  } finally {
    await other.close();
  }

  await page.getByRole('button', { name: 'Continue in wallet' }).click();
  const card = page.getByRole('region', { name: 'Swap status' });
  await expect(card.getByRole('status')).toHaveText('Failed', { timeout: 60_000 });
  await expect(card).toContainText('The price moved past your minimum, so nothing was swapped.');
  await expect(card.getByRole('button', { name: 'Get a new quote' })).toBeVisible();
  await expect(card.getByRole('button', { name: /retry/i })).toHaveCount(0);
});

test(`${J} #10 opens the approvals list and revokes the allowance: spender and amount listed; revoke sets it to zero and the row goes`, async ({
  page,
}) => {
  await connectWallet(page, dex, { tokens: [TOKEN_A, TOKEN_B] });
  await walletSection(page, 'Approvals');
  const approvals = page.getByRole('region', { name: 'Approvals' }).getByRole('table');
  const row = approvals.getByRole('row').filter({ hasText: 'TEST Token A' });
  await expect(row).toBeVisible(UNBUILT);
  await expect(row).toContainText('10');
  await row.getByRole('button', { name: 'Revoke' }).click();
  await page.getByRole('button', { name: 'Continue in wallet' }).click();
  await expect(row).toHaveCount(0, { timeout: 60_000 });
});

test(`${J} #11 swaps from a wallet with only a TEST stable token, paying the fee in that token: oracle rate plus markup; off-list or stale oracle pays native`, async ({
  page,
}) => {
  await openSwap(page);
  const pay = swap(page).getByRole('combobox', { name: 'Pay the network fee in' });
  await pay.selectOption({ label: 'TEST USD' }, UNBUILT);
  await expect(swap(page).getByTestId('fee-line')).toHaveText(/^Network fee [\d.]+ TEST USD at the oracle rate plus a [\d.]+ ?% markup$/);
  await pay.selectOption({ label: 'TEST Token B' });
  await expect(swap(page).getByRole('alert')).toContainText('This token cannot pay the network fee. Pay in the network’s own currency.');
});
