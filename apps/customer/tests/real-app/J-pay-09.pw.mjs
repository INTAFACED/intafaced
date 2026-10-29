import { test, expect } from '@playwright/test';
import { journeyState, toUnits } from './stack.mjs';
import { signIn } from './desk.mjs';
import { member, usdt } from './pay.mjs';

// J-pay-09, in the running app (docs/roadmap/journeys.json): pay by scanning a code or a personal link. One test per step,
// titled "J-pay-09 #<n>", run in order. #1 makes the start: a verified TEST payee and a verified payer with TEST 50 USDT.
// The payee's QR is the one Receive shows; the scan reads it from an image file, as "Choose an image of a QR code" does.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - #1, #2: Scan is not connected ("a real INTAFACED QR code cannot be told from a forged one"); no merchant QR.
// - #3 to #5: Receive's link opens a prefilled Send; there is no preset-amount, one-time, off or expiring link.
const J = 'J-pay-09';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const UNBUILT = { timeout: 5_000 };

test.describe.configure({ mode: 'default' });
// An action on a part that never appears fails in 15 s, not at the test's time limit.
test.use({ actionTimeout: 15_000 });

function state(key) {
  const value = run.read()[key];
  if (!value) throw new Error(`${J}: an earlier step made no ${key}, so this step has nothing to act on`);
  return value;
}

/** The payee makes a link on Receive with the given options, and returns it. */
async function makeLink(page, { amount, oneTime = false } = {}) {
  await signIn(page, state('payee'));
  await page.goto('/pay/receive');
  await page.getByRole('button', { name: 'Make a payment link' }).click(UNBUILT);
  const sheet = page.getByRole('dialog', { name: 'Payment link' });
  if (amount) await sheet.getByLabel('Amount').fill(amount);
  if (oneTime) await sheet.getByRole('checkbox', { name: 'Can be paid once' }).check();
  await sheet.getByRole('button', { name: 'Make link' }).click();
  return (await sheet.getByTestId('payment-link').innerText()).trim();
}

test(`${J} #1 opens Scan and scans a person's QR: Send opens prefilled with a payee preview`, async ({ page }) => {
  test.setTimeout(240_000);
  const payee = await member(page, 'jpqe');
  const payer = await member(page, 'jpqr', '50');
  run.reset({ payee, payer });
  await signIn(page, payee);
  await page.goto('/pay/receive');
  const qr = await page.getByRole('img', { name: 'QR code for your payment link' }).screenshot();
  await signIn(page, payer);
  await page.goto('/pay/scan');
  await page.getByLabel('Choose an image of a QR code').setInputFiles({ name: 'qr.png', mimeType: 'image/png', buffer: qr });
  await expect(page.getByLabel('Handle')).toHaveValue(new RegExp(payee.handle), UNBUILT);
});

test(`${J} #2 scans a merchant QR in a store: the merchant payment session opens and pays from the balance`, async ({ page }) => {
  await signIn(page, state('payer'));
  await page.goto('/pay/scan');
  await expect(page.getByRole('button', { name: 'Scan with the camera' })).toBeEnabled(UNBUILT);
});

test(`${J} #3 creates a personal link with a preset amount: the payer can't change it`, async ({ page }) => {
  const link = await makeLink(page, { amount: '7' });
  await signIn(page, state('payer'));
  await page.goto(link);
  await expect(page.getByLabel('Amount to send')).toHaveValue('7');
  await expect(page.getByLabel('Amount to send')).not.toBeEditable();
});

test(`${J} #4 creates a one-time link and a payer opens it twice: one payment; the second opening reads redeemed`, async ({ page }) => {
  const link = await makeLink(page, { amount: '3', oneTime: true });
  const payer = state('payer');
  const before = await usdt(payer);
  await signIn(page, payer);
  await page.goto(link);
  await page.getByTestId('pay-review').click();
  await page.getByTestId('pay-send').click();
  await page.goto(link);
  await expect(page.getByText('This link has been paid.')).toBeVisible();
  expect(toUnits(before) - toUnits(await usdt(payer))).toBe(toUnits('3'));
});

test(`${J} #5 turns a link off, and another passes its window: off or expired and no payment`, async ({ page }) => {
  const link = await makeLink(page, { amount: '2' });
  await page.goto('/pay/receive');
  await page
    .getByRole('row', { name: new RegExp(link.split('/').at(-1)) })
    .getByRole('button', { name: 'Turn off' })
    .click();
  await signIn(page, state('payer'));
  await page.goto(link);
  await expect(page.getByText('This link is off.')).toBeVisible();
});
