import path from 'node:path';
import { test, expect } from '@playwright/test';
import { EDGE, ORIGIN, ROOT, fund, journeyState, toUnits } from './stack.mjs';
import { signUp, verify } from './desk.mjs';
import { addAuthenticator, nextCode } from './identity-factors.mjs';

// J-bank-05, in the running app (docs/roadmap/journeys.json): I send money abroad from Pay's global send. The local stack
// chooses the TEST global-send stand-in (BANK_GLOBAL_PARTNER=global-sim): its catalogue is the bank profile's TEST values
// (two made-up corridors, rates of 2 and 3, no fee), it pays nobody, and it is refused under live posture. Every number
// here is a TEST number on the local stack. Not here yet: #3's conversion recipe and the expired lock, #4 (needs a
// corridor with no stand-in) and #5 (receive details).
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
  await page.context().clearCookies();
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
    body: JSON.stringify({ identifier: who.email, password: who.password, totpCode: await code() }),
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
  await signIn(page);
  const card = await toGermany(page);
  const where = card.getByLabel('Where it goes');
  // Exactly the stand-in's two TEST corridors: nothing typed in the app, nothing more.
  await expect(where.locator('option')).toHaveText(['Choose a country and currency', 'DE · EUR · sepa', 'GB · GBP · bank_account']);
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
  // The stand-in's TEST rate of 2 and no fee: 40 USDT in, 80 EUR out, as the service's own strings.
  await expect(quote).toContainText('2', { timeout: 30_000 });
  await expect(quote).toContainText('0 USDT');
  await expect(quote).toContainText('80');
  await expect(card).toContainText('Valid until');
});

test(`${J} the TEST stand-in: a confirmed send leaves the account once and shows in the history`, async ({ page }) => {
  test.setTimeout(300_000);
  await signIn(page);
  const before = await usdt();
  const card = await toGermany(page);
  await card.getByLabel('Recipient', { exact: true }).selectOption({ index: 1 });
  await card.getByLabel('You send').fill('40');
  await card.getByRole('button', { name: 'Get a quote' }).click();
  await expect(card.getByTestId('global-quote')).toContainText('80', { timeout: 30_000 });
  await card.getByRole('button', { name: 'Review and send' }).click();
  const confirm = card.getByTestId('global-confirm');
  await confirm.getByLabel('Authenticator code').fill(await code());
  await confirm.getByRole('button', { name: 'Confirm with a code' }).click();
  await expect(card.getByTestId('global-sent')).toBeVisible({ timeout: 30_000 });
  await expect(card.getByTestId('global-history')).toContainText('40', { timeout: 30_000 });
  expect(toUnits(await usdt())).toBe(toUnits(before) - toUnits('40'));
});
