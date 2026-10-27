import { test, expect } from '@playwright/test';
import { TOKEN_A, TOKEN_B, UNBUILT, connectWallet, dexRun } from './dex.mjs';

// J-dex-protocol-03, in the running app (docs/roadmap/journeys.json): swap smarter with permits, per-hop floors and signed
// intent orders. One test per step, titled "J-dex-protocol-03 #<n>", run in order with one TEST wallet on Base Sepolia.
// TEST token A answers its permit domain (EIP-5267) through the TEST wallet; TEST token B is handed to no wallet answer,
// so it reads as a token without permit. Every swap and order is signed by the person's own wallet; nothing posts to the
// ledger. A relay that is off shows the user-submit fallback and rail.crypto.
// Every step is written; none is built yet, so each fails at its first missing part, quickly (UNBUILT):
// - /dex's Swap tab is today's route-quote desk: there is no token-in/token-out form, so no permit or approve step,
//   standing allowance, hop limit, exact-output mode or deadline (D-swap-03, D-swap-intents-01, -02);
// - there is no intent order (D-swap-09) and no smart-account delegation or signer key (D-swap-intents-05);
// - the stack has no TEST chain, router, relay or filler, so nothing a step signs can mine or fill.
const J = 'J-dex-protocol-03';
const dex = dexRun(J);

test.describe.configure({ mode: 'default' });

const swap = (page) => page.getByRole('form', { name: 'Swap' });
const tokenIn = (page) => swap(page).getByRole('combobox', { name: 'You pay' });
const tokenOut = (page) => swap(page).getByRole('combobox', { name: 'You receive' });
const amountIn = (page) => swap(page).getByRole('textbox', { name: /^Amount you pay/ });
const swapButton = (page) => swap(page).getByRole('button', { name: 'Swap', exact: true });
const steps = (page) => page.getByRole('list', { name: 'Swap steps' });

/** Opens /dex's Swap form with the run's wallet connected; only TEST token A answers a permit domain. */
async function openSwap(page) {
  const wallet = await connectWallet(page, dex, { tokens: [TOKEN_A] });
  await page.goto('/dex');
  await expect(swap(page)).toBeVisible(UNBUILT);
  return wallet;
}

/** Picks `from` in, `to` out and types `amount`. */
async function quote(page, from, to, amount = '10') {
  await tokenIn(page).selectOption({ label: from.name }, UNBUILT);
  await tokenOut(page).selectOption({ label: to.name });
  await amountIn(page).fill(amount);
}

/** Opens the intent order form (Swap's "Intent order" mode). */
async function openIntent(page) {
  const wallet = await openSwap(page);
  await swap(page).getByRole('radio', { name: 'Intent order' }).check(UNBUILT);
  return { wallet, form: page.getByRole('form', { name: 'Intent order' }) };
}

test(`${J} starts: a TEST wallet on Base Sepolia, a token with a permit and one without, a two-hop route`, async ({ page }) => {
  dex.start();
  await openSwap(page);
});

test(`${J} #1 swaps a token that supports permit: one signature for the exact amount and deadline instead of an approve transaction; reusing the signature fails`, async ({
  page,
}) => {
  const wallet = await openSwap(page);
  await quote(page, TOKEN_A, TOKEN_B, '10');
  await swapButton(page).click();
  await expect(
    steps(page)
      .getByRole('listitem')
      .filter({ hasText: /^Approve/ }),
  ).toHaveCount(0, UNBUILT);
  await expect(steps(page).getByRole('listitem').filter({ hasText: 'Sign a permit for exactly 10 TEST Token A' })).toHaveCount(1);
  const sheet = page.getByRole('dialog', { name: 'Check before you sign' });
  await expect(sheet.getByRole('term').filter({ hasText: 'Amount' })).toBeVisible();
  await expect(sheet.getByRole('term').filter({ hasText: 'Expires' })).toBeVisible();
  await sheet.getByRole('button', { name: 'Continue in wallet' }).click();
  expect(wallet.requests.filter((r) => r.method === 'eth_signTypedData_v4')).toHaveLength(1);
  expect(wallet.requests.filter((r) => r.method === 'eth_sendTransaction' && /approve/i.test(JSON.stringify(r.params)))).toHaveLength(0);
  // The same signature sent again is refused by name, never a second pull.
  await page.getByRole('button', { name: 'Reuse last permit' }).click();
  await expect(page.getByRole('alert')).toContainText('This permit was already used');
});

test(`${J} #2 swaps a token without permit: the room says it has no permit and falls back to the approve step`, async ({ page }) => {
  await openSwap(page);
  await quote(page, TOKEN_B, TOKEN_A, '10');
  await expect(swap(page).getByRole('note')).toContainText('TEST Token B has no permit', UNBUILT);
  await swapButton(page).click();
  await expect(steps(page).getByRole('listitem').filter({ hasText: 'Approve exactly 10 TEST Token B' })).toHaveCount(1);
});

test(`${J} #3 chooses a standing allowance with an expiry: the expiry is shown; a pull after it is refused`, async ({ page }) => {
  await openSwap(page);
  await quote(page, TOKEN_A, TOKEN_B, '10');
  const allowance = swap(page).getByRole('radiogroup', { name: 'Allowance' });
  await allowance.getByRole('radio', { name: /^Standing allowance/ }).check(UNBUILT);
  await swap(page).getByRole('combobox', { name: 'Allowance expires' }).selectOption({ label: '1 hour' });
  await expect(swap(page).getByTestId('allowance-expiry')).toHaveText(/^Expires \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
  // The page clock moves past the expiry; the next swap is refused rather than pulled.
  await page.clock.install();
  await page.clock.fastForward('02:00:00');
  await swapButton(page).click();
  await expect(swap(page).getByRole('alert')).toContainText('The standing allowance expired');
});

test(`${J} #4 builds a three-hop swap with the hop limit blank: a typed refusal naming the hop limit; with it set, per-hop minimums; a hop under its minimum reverts the whole swap`, async ({
  page,
}) => {
  await openSwap(page);
  await quote(page, TOKEN_A, TOKEN_B, '10');
  await swap(page).getByRole('button', { name: 'Route options' }).click(UNBUILT);
  await page.getByRole('spinbutton', { name: 'Hops' }).fill('3');
  // The owner's hop limit is blank on the stack: the build is refused with its typed code.
  await expect(page.getByRole('alert')).toContainText('dex.route.hop_limit_unset');
  await expect(swapButton(page)).toBeDisabled();
  // With the limit set (a later stack seed), each hop shows its own floor and one under it reverts the whole swap.
  const hops = page.getByRole('region', { name: 'Hops' }).getByRole('table');
  await expect(hops.getByRole('columnheader', { name: 'Minimum out' })).toBeVisible();
  await expect(page.getByRole('status', { name: 'Swap status' })).toHaveText('Reverted: a hop paid under its minimum. Nothing moved.');
});

test(`${J} #5 chooses exact-output with native input: the maximum paid, the deadline and the wrap step; a deadline in the past is refused`, async ({
  page,
}) => {
  await openSwap(page);
  await swap(page).getByRole('radio', { name: 'Exact output' }).check(UNBUILT);
  await tokenIn(page).selectOption({ label: 'ETH' });
  await tokenOut(page).selectOption({ label: TOKEN_B.name });
  await swap(page)
    .getByRole('textbox', { name: /^Amount you receive/ })
    .fill('5');
  await expect(swap(page).getByTestId('maximum-paid')).toHaveText(/^Maximum paid [\d,.]+ ETH$/);
  await expect(swap(page).getByTestId('deadline')).toHaveText(/^Deadline /);
  await swapButton(page).click();
  await expect(steps(page).getByRole('listitem').filter({ hasText: 'Wrap ETH' })).toHaveCount(1);
  await page.getByRole('button', { name: 'Back' }).click();
  await swap(page)
    .getByRole('textbox', { name: /^Deadline/ })
    .fill('2020-01-01T00:00');
  await expect(swap(page).getByRole('alert')).toContainText('The deadline is in the past');
});

test(`${J} #6 places a signed intent order with a Dutch-auction decay: starts at the best price and decays to the floor over the stated time; a replayed signature is refused`, async ({
  page,
}) => {
  const { form } = await openIntent(page);
  await form.getByRole('combobox', { name: 'You pay' }).selectOption({ label: TOKEN_A.name });
  await form.getByRole('combobox', { name: 'You receive' }).selectOption({ label: TOKEN_B.name });
  await form.getByRole('textbox', { name: /^Amount you pay/ }).fill('10');
  await form.getByRole('textbox', { name: /^Floor/ }).fill('9');
  await form.getByRole('textbox', { name: /^Decay over \(minutes\)/ }).fill('10');
  await form.getByRole('button', { name: 'Review order' }).click();
  const review = page.getByRole('dialog', { name: 'Review the intent order' });
  await expect(review).toContainText(/Starts at [\d,.]+ TEST Token B/);
  await expect(review).toContainText('Decays to 9 TEST Token B over 10 minutes');
  await review.getByRole('button', { name: 'Continue in wallet' }).click();
  const orders = page.getByRole('region', { name: 'Intent orders' }).getByRole('table');
  await expect(orders.getByRole('row').filter({ hasText: 'Open' })).toHaveCount(1);
  await page.getByRole('button', { name: 'Reuse last signature' }).click();
  await expect(page.getByRole('alert')).toContainText('This order signature was already used');
});

test(`${J} #7 watches the order fill at the midpoint: received equals the decayed price at that second and the order reads filled`, async ({
  page,
}) => {
  await openIntent(page);
  const orders = page.getByRole('region', { name: 'Intent orders' }).getByRole('table');
  const filled = orders.getByRole('row').filter({ hasText: 'Filled' });
  await expect(filled).toHaveCount(1, UNBUILT);
  // The row names the fill second and the decayed price there, and the received amount is that price.
  const text = await filled.innerText();
  const price = text.match(/Price at fill ([\d.]+)/)?.[1];
  const received = text.match(/Received ([\d.]+)/)?.[1];
  expect(price).toBeTruthy();
  expect(received).toBe(price);
});

test(`${J} #8 delegates to a smart account and batches approve and swap: both succeed or both revert; an existing delegation is refused; with the relay off the user-submit fallback and blocker`, async ({
  page,
}) => {
  await connectWallet(page, dex, { tokens: [TOKEN_A] });
  await page.getByRole('button', { name: 'Create a smart account' }).click(UNBUILT);
  const delegate = page.getByRole('dialog', { name: 'Use a smart account' });
  await delegate.getByRole('button', { name: 'Continue in wallet' }).click();
  await page.goto('/dex');
  await quote(page, TOKEN_B, TOKEN_A, '10');
  await swap(page).getByRole('checkbox', { name: 'Approve and swap in one batch' }).check();
  await swapButton(page).click();
  await expect(steps(page).getByRole('listitem')).toHaveCount(1);
  await expect(steps(page)).toContainText('Approve and swap together: both happen or neither does');
  // A second delegation for the same account is refused with its reason.
  await page.getByRole('button', { name: 'Create a smart account' }).click();
  await expect(page.getByRole('alert')).toContainText('This account already delegates to a smart account');
  // The stack has no relay: the person can still send it themselves, and the blocker says why.
  await expect(page.getByText('Send it yourself', { exact: true })).toBeVisible();
  await expect(page.getByText(/rail\.crypto/)).toBeVisible();
});

test(`${J} #9 adds a signer key with an expiry: the key works until its expiry and not after`, async ({ page }) => {
  await connectWallet(page, dex, { tokens: [TOKEN_A] });
  await page.getByRole('button', { name: 'Add a signer key' }).click(UNBUILT);
  const add = page.getByRole('dialog', { name: 'Add a signer key' });
  await add.getByRole('combobox', { name: 'Expires' }).selectOption({ label: '1 hour' });
  // A signer key can never carry withdrawal power (services/svc-protocol/src/session/spec.test.ts).
  await expect(add.getByRole('checkbox', { name: /^Withdraw/ })).toHaveCount(0);
  await add.getByRole('button', { name: 'Continue in wallet' }).click();
  const keys = page.getByRole('region', { name: 'Signer keys' }).getByRole('table');
  await expect(keys.getByRole('row').filter({ hasText: 'Active' })).toHaveCount(1);
  await page.clock.install();
  await page.clock.fastForward('02:00:00');
  await page.reload();
  await expect(keys.getByRole('row').filter({ hasText: 'Expired' })).toHaveCount(1);
});
