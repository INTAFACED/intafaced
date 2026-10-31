import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from './journey.mjs';
import { DEVICE_KEY, EDGE, ORIGIN, ROOT, fund, journeyState, toUnits, signOutBrowser } from './stack.mjs';
import { signUp, verify } from './desk.mjs';
import { addAuthenticator, nextCode } from './identity-factors.mjs';

// J-bank-05, in the running app (docs/roadmap/journeys.json): I send money abroad from Pay's global send. The local stack
// chooses the TEST global-send stand-in (BANK_GLOBAL_PARTNER=global-sim): its catalogue is the bank profile's TEST values
// (three made-up corridors, rates of 2 and 3, no fee, a 300-second quote lock; NL is listed and quoted but has no payout,
// the way a corridor with no partner behaves), it pays nobody, and it is refused under live posture. Every number here is a
// TEST number on the local stack. A send converts at the rail: the bank posts the amount once to the rail boundary and the
// rail pays the locked receive amount. Receive details come from the bank's account details: no banking partner is
// connected, so each currency names rail.bank and shows no number.
const J = 'J-bank-05';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });

const totpLib = () => import(path.join(ROOT, 'services/svc-identity/dist/auth/totp.js'));

async function code() {
  const now = run.read();
  const { totp } = await totpLib();
  const next = await nextCode(totp, now.secret, now.step);
  run.write({ step: next.step });
  return next.code;
}

/** A verified sender with TEST 100 USDT and an authenticator app, made on first use. */
async function sender(page) {
  const now = run.read();
  if (now.sender && now.secret) return now.sender;
  const who = await signUp(page, 'jb5s');
  await verify(page, who);
  expect(fund(who.email, 'USDT', '100').tx).toBeTruthy();
  await page.goto('/login');
  await page.fill('input[name=identifier]', who.email);
  await page.fill('input[name=password]', who.password);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page).not.toHaveURL(/\/login/);
  const { totp } = await totpLib();
  const { secret, step } = await addAuthenticator(page, totp);
  run.reset({ sender: who, secret, step });
  await page.goto('about:blank');
  await signOutBrowser(page.context());
  return who;
}

async function signIn(page) {
  const who = await sender(page);
  const totpCode = await code();
  await page.goto('/login');
  await page.fill('input[name=totp]', totpCode);
  await page.fill('input[name=identifier]', who.email);
  await page.fill('input[name=password]', who.password);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

/** The sender's free USDT through their own API, with a fresh code. */
async function usdt() {
  const { sender: who } = run.read();
  const login = await fetch(`${EDGE}/api/identity/trpc/auth.login`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ deviceKey: DEVICE_KEY, identifier: who.email, password: who.password, totpCode: await code() }),
  }).then((r) => r.json());
  const token = login?.result?.data?.accessToken;
  if (!token) throw new Error(`sign-in for ${who.email} refused`);
  const res = await fetch(`${EDGE}/api/v1/account/balance`, { headers: { origin: ORIGIN, authorization: `Bearer ${token}` } });
  return (await res.json()).balances?.USDT?.free ?? '0';
}

/** Pay's global send with Germany, euro over SEPA chosen, and a recipient saved for it. */
async function toGermany(page) {
  await page.goto('/pay/global');
  const card = page.getByTestId('global-card');
  const where = card.getByLabel('Where it goes');
  await expect(where.locator('option', { hasText: 'DE · EUR · sepa' })).toHaveCount(1, { timeout: 30_000 });
  await where.selectOption({ label: 'DE · EUR · sepa' });
  return card;
}

test(`${J} #1 opens global send and picks the corridor: its limits show, and a corridor the catalogue lacks is not offered`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  // Step 1 starts the journey again: a new sender with no recipients and no sends.
  run.reset({});
  await signIn(page);
  const card = await toGermany(page);
  // Every figure on this card comes from the stand-in, and the card says so.
  await expect(card.getByTestId('global-stand-in')).toContainText('TEST');
  await expect(card.getByTestId('global-stand-in')).toContainText('Nobody receives the money');
  const where = card.getByLabel('Where it goes');
  // Exactly the stand-in's three TEST corridors: nothing typed in the app, nothing more.
  await expect(where.locator('option')).toHaveText([
    'Choose a country and currency',
    'DE · EUR · sepa',
    'GB · GBP · bank_account',
    'NL · EUR · sepa',
  ]);
  await expect(card.getByTestId('global-limits')).toHaveText('The smallest send is 1. The largest send is 1000.');
  // The recipient form for the corridor: name and IBAN, checked for format before it is saved.
  await card.getByLabel('Recipient’s full name').fill('Ada TEST');
  await card.getByLabel('Account number or IBAN').fill('DE89 3704 0044 0532 0130 00');
  await card.getByTestId('global-recipient-save').click();
  await expect(card.getByLabel('Recipient', { exact: true }).locator('option', { hasText: 'Ada TEST' })).toHaveCount(1, {
    timeout: 30_000,
  });
});

test(`${J} #2 reads the quote: rate, fee, receive amount and valid-until from the provider's answer`, async ({ page }) => {
  test.setTimeout(240_000);
  await signIn(page);
  const card = await toGermany(page);
  await card.getByLabel('Recipient', { exact: true }).selectOption({ index: 1 });
  await card.getByLabel('You send').fill('40');
  await card.getByRole('button', { name: 'Get a quote' }).click();
  const quote = card.getByTestId('global-quote');
  const cell = (term) =>
    quote
      .locator('div')
      .filter({ has: page.getByText(term, { exact: true }) })
      .locator('dd');
  // The stand-in's TEST rate of 2 and no fee: 40 USDT in, 80 EUR out, each figure exactly as the service gave it.
  await expect(cell('Exchange rate')).toHaveText('2', { timeout: 30_000 });
  await expect(cell('Fee')).toHaveText('0 USDT');
  await expect(cell('They receive')).toHaveText('80 EUR');
  await expect(card.getByText(/^Valid until \d{4}-\d{2}-\d{2}T/)).toBeVisible();
  await expect(card.getByTestId('global-stand-in')).toContainText('TEST');
});

test(`${J} #3 locks the rate and confirms: the send is paid at exactly the locked quote, once`, async ({ page }) => {
  test.setTimeout(300_000);
  await signIn(page);
  const before = await usdt();
  const card = await toGermany(page);
  await card.getByLabel('Recipient', { exact: true }).selectOption({ index: 1 });
  await card.getByLabel('You send').fill('40');
  await card.getByRole('button', { name: 'Get a quote' }).click();
  // The quote is a lock, counting down from the stand-in's TEST 300 seconds.
  await expect(card.getByTestId('global-lock')).toHaveText(/^Rate locked for [45]:\d{2}\. Confirm inside it/, { timeout: 30_000 });
  await expect(card.getByTestId('global-quote')).toContainText('80 EUR');
  await card.getByRole('button', { name: 'Review and send' }).click();
  const confirm = card.getByTestId('global-confirm');
  await expect(confirm.getByTestId('global-confirm-lock')).toContainText('Rate locked for');
  await expect(confirm).toContainText('80 EUR');
  await confirm.getByLabel('Authenticator code').fill(await code());
  await confirm.getByRole('button', { name: 'Confirm with a code' }).click();
  await expect(card.getByTestId('global-sent')).toBeVisible({ timeout: 30_000 });
  const row = card.getByTestId('global-history').locator('li').first();
  await expect(row).toContainText('40', { timeout: 30_000 });
  // The signed receipt carries the locked figures: rate 2, they receive 80 EUR.
  const [download] = await Promise.all([page.waitForEvent('download'), row.getByRole('button', { name: 'Download receipt' }).click()]);
  const receipt = readFileSync(await download.path(), 'utf8');
  expect(receipt).toContain('Sent: 40 USDT');
  expect(receipt).toContain('They receive: 80 EUR');
  expect(receipt).toContain('Rate: 2');
  // Exactly the amount left, once.
  expect(toUnits(await usdt())).toBe(toUnits(before) - toUnits('40'));
});

test(`${J} #3 after the lock runs out, the quote must be taken again before anything is sent`, async ({ page }) => {
  test.setTimeout(240_000);
  // The browser's clock only: it is moved past the lock without waiting five minutes. The service keeps its own time.
  await page.clock.install();
  await signIn(page);
  const card = await toGermany(page);
  await card.getByLabel('Recipient', { exact: true }).selectOption({ index: 1 });
  await card.getByLabel('You send').fill('40');
  await card.getByRole('button', { name: 'Get a quote' }).click();
  await expect(card.getByTestId('global-lock')).toContainText('Rate locked for', { timeout: 30_000 });
  await page.clock.fastForward('05:01');
  await expect(card.getByTestId('global-lock-over')).toHaveText('The rate lock ran out. Get a new quote to send.');
  await card.getByRole('button', { name: 'Review and send' }).click();
  await expect(card.getByTestId('global-failure')).toContainText('This quote has expired');
  await expect(card.getByTestId('global-confirm')).toHaveCount(0);
  // A new quote is a new lock, and the send can go on from there.
  await card.getByRole('button', { name: 'Get a quote' }).click();
  await expect(card.getByTestId('global-lock')).toContainText('Rate locked for', { timeout: 30_000 });
  await card.getByRole('button', { name: 'Review and send' }).click();
  await expect(card.getByTestId('global-confirm')).toBeVisible();
});

test(`${J} #4 with no partner for the destination, pressing send names it, nothing leaves, and the send is kept`, async ({ page }) => {
  test.setTimeout(300_000);
  await signIn(page);
  const before = await usdt();
  await page.goto('/pay/global');
  const card = page.getByTestId('global-card');
  const where = card.getByLabel('Where it goes');
  await expect(where.locator('option', { hasText: 'NL · EUR · sepa' })).toHaveCount(1, { timeout: 30_000 });
  await where.selectOption({ label: 'NL · EUR · sepa' });
  // The destination says before anything is sent that no partner pays out there.
  await expect(card.getByTestId('global-no-payout')).toHaveText(
    'No payout partner is connected for this destination. A send here is refused, nothing leaves your balance, and the send is kept in your history.',
  );
  await card.getByLabel('Recipient’s full name').fill('Daan TEST');
  await card.getByLabel('Account number or IBAN').fill('NL91 ABNA 0417 1643 00');
  await card.getByTestId('global-recipient-save').click();
  const recipient = card.getByLabel('Recipient', { exact: true });
  await expect(recipient.locator('option', { hasText: 'Daan TEST' })).toHaveCount(1, { timeout: 30_000 });
  await recipient.selectOption({ label: await recipient.locator('option', { hasText: 'Daan TEST' }).innerText() });
  await card.getByLabel('You send').fill('41');
  await card.getByRole('button', { name: 'Get a quote' }).click();
  // The rate is the partner's answer for the currency, so a quote still comes back.
  await expect(card.getByTestId('global-quote')).toContainText('82 EUR', { timeout: 30_000 });
  await card.getByRole('button', { name: 'Review and send' }).click();
  const confirm = card.getByTestId('global-confirm');
  await confirm.getByLabel('Authenticator code').fill(await code());
  await confirm.getByRole('button', { name: 'Confirm with a code' }).click();
  await expect(card.getByTestId('global-failure')).toContainText('No payout partner for this destination', { timeout: 30_000 });
  await expect(card.getByTestId('global-sent')).toHaveCount(0);
  // The intent row is kept, refused with nothing taken.
  const row = card.getByTestId('global-history').locator('li[data-status="failed"]', { hasText: '41 USDT to EUR' });
  await expect(row).toContainText('41 USDT to EUR', { timeout: 30_000 });
  await expect(row).toContainText('It was not sent and nothing remains taken from your balance.');
  expect(toUnits(await usdt())).toBe(toUnits(before));
});

test(`${J} #5 opens receive details for a currency: each names the banking partner it needs, and no number is shown`, async ({ page }) => {
  test.setTimeout(240_000);
  await signIn(page);
  await page.goto('/pay/global');
  const receive = page.getByTestId('global-receive');
  await expect(receive).toContainText('Receive money from abroad');
  const picker = receive.getByLabel('Currency to receive');
  await expect(picker.locator('option', { hasText: 'EUR' })).toHaveCount(1, { timeout: 30_000 });
  await picker.selectOption('EUR');
  const block = receive.getByTestId('account-details-EUR');
  await expect(block).toContainText('Needs a banking partner. It is switched off in this build.');
  await expect(block).toContainText('rail.bank');
  await expect(block.getByTestId('account-details-set')).toHaveCount(0);
  await expect(receive).not.toContainText(/IBAN|Sort code|Account number/);
});
