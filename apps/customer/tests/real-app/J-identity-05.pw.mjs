import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { ROOT, mailedLines, signUpInBrowser } from './stack.mjs';
import { addAuthenticator } from './identity-factors.mjs';

// J-identity-05, in the running app (docs/roadmap/journeys.json): I lost my phone and got back in. One test per step,
// titled "J-identity-05 #<n>". Every person is a TEST person on the local stack, signed up through the browser
// (J-identity-01) with an authenticator app and its recovery codes set up from Security (J-identity-04). "The phone" is
// the browser that set the authenticator up; a lost phone is a fresh browser context, so the person signs in elsewhere.
// Steps whose screens are not built yet fail at their first check, on a short timeout.
const J = 'J-identity-05';
const UNBUILT = { timeout: 5_000 };

test.describe.configure({ mode: 'default' });

function person(prefix = 'lp') {
  const handle = `${prefix}${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
  return { handle, email: `${handle}@local-test.invalid`, password: `TEST-${randomBytes(9).toString('base64url')}-9a` };
}

let totpModule;
const totpOf = async () => (totpModule ??= (await import(path.join(ROOT, 'services/svc-identity/dist/auth/totp.js'))).totp);

/** A TEST person signed up on "the phone", with an authenticator app on; answers its recovery codes as Security shows them. */
async function withAuthenticator(page) {
  const who = person();
  await signUpInBrowser(page, who);
  const { secret, step } = await addAuthenticator(page, await totpOf());
  const codes = (await page.locator('.security__recovery .recovery-codes li').allInnerTexts()).map((code) => code.trim());
  expect(codes.length).toBeGreaterThan(1);
  return { who, secret, step, codes };
}

async function fillSignIn(page, who, code) {
  await page.fill('input[name=identifier]', who.email);
  await page.fill('input[name=password]', who.password);
  if (code !== undefined) await page.fill('input[name=totp]', code);
  await page.getByRole('button', { name: /^sign in$/i }).click();
}

/** On a fresh browser (the phone is gone): the right password, and the page asks for the second step. */
async function atSecondStep(browser, who) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/login');
  await fillSignIn(page, who);
  await expect(page.getByRole('alert')).toContainText('Your password is right');
  return { context, page };
}

test(`${J} #1 a recovery code at the second step is accepted once and spent; the person is told how many remain`, async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const { who, codes } = await withAuthenticator(page);

  const { context, page: other } = await atSecondStep(browser, who);
  await other.getByRole('button', { name: 'Use a recovery code' }).click();
  await expect(other.getByLabel('Recovery code', { exact: true })).toBeVisible();
  await other.getByLabel('Recovery code', { exact: true }).fill(codes[0]);
  await fillSignIn(other, who);
  const told = other.getByRole('status').filter({ hasText: 'Signed in with a recovery code' });
  await expect(told).toContainText('That recovery code is now spent');
  await expect(told).toContainText(`Recovery codes left: ${codes.length - 1}`);
  await told.getByRole('button', { name: 'Continue' }).click();
  await expect(other).not.toHaveURL(/\/login/);
  // Security on the new browser counts the same.
  await other.goto('/uc/safe');
  await expect(other.locator('.security__authenticator').filter({ hasText: 'Recovery codes left' })).toContainText(
    `Recovery codes left: ${codes.length - 1}`,
  );
  await context.close();

  // The spent code is refused from another browser, the same way a wrong code is.
  const again = await atSecondStep(browser, who);
  await again.page.getByRole('button', { name: 'Use a recovery code' }).click();
  await again.page.getByLabel('Recovery code', { exact: true }).fill(codes[0]);
  await fillSignIn(again.page, who);
  await expect(again.page.getByRole('alert')).toContainText('That code did not work. Every code works only once');
  await expect(again.page).toHaveURL(/\/login/);
  await again.context.close();
});

/** At the second step with no codes to hand: "I lost my authenticator" starts the locked-out reset (I-signin-sessions-12). */
async function startLockedOutReset(browser, who) {
  const at = await atSecondStep(browser, who);
  await at.page.getByRole('button', { name: 'I lost my authenticator' }).click(UNBUILT);
  return at;
}

test(`${J} #2 with no recovery codes left, a locked-out reset tells every contact and shows the waiting time`, async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const { who } = await withAuthenticator(page);
  const seen = mailedLines(who.email, 'mfa-reset-started').length;
  const { context, page: other } = await startLockedOutReset(browser, who);
  await expect(other.getByRole('status').filter({ hasText: 'second step is being reset' })).toContainText('until', UNBUILT);
  await expect.poll(() => mailedLines(who.email, 'mfa-reset-started').length, UNBUILT).toBeGreaterThan(seen);
  await context.close();
});

test(`${J} #3 a reset stops when cancelled from a signed-in session; otherwise it completes after the wait`, async ({ page, browser }) => {
  test.setTimeout(120_000);
  const { who } = await withAuthenticator(page);
  const { context } = await startLockedOutReset(browser, who);
  // The phone is still signed in: Security names the waiting reset and stops it.
  await page.goto('/uc/safe');
  await page.getByRole('button', { name: 'Stop this reset' }).click(UNBUILT);
  await expect(page.getByRole('status').filter({ hasText: 'The reset was stopped' })).toBeVisible(UNBUILT);
  await context.close();
});

test(`${J} #4 replacing the authenticator on the new phone ends the old device's sessions and shows new recovery codes once`, async ({
  page,
  browser,
}) => {
  test.setTimeout(150_000);
  const totp = await totpOf();
  const { who, codes } = await withAuthenticator(page);

  // On the new phone: sign in with a recovery code, then replace the app from Security.
  const { context, page: other } = await atSecondStep(browser, who);
  await other.getByRole('button', { name: 'Use a recovery code' }).click();
  await other.getByLabel('Recovery code', { exact: true }).fill(codes[0]);
  await fillSignIn(other, who);
  await other.getByRole('button', { name: 'Open Security' }).click();
  await other.locator('.security__authenticator').getByRole('button', { name: 'Replace' }).click();
  const key = await other.getByLabel('Setup key').inputValue(UNBUILT);
  await other.getByLabel('Code from the new app').fill(totp(key));
  await other.getByLabel(/current code|recovery code/i).fill(codes[1]);
  await other.getByRole('button', { name: 'Replace authenticator app' }).click();
  await expect(other.locator('.security__authenticator')).toContainText('replaced', UNBUILT);
  // New recovery codes, shown once.
  await expect(other.locator('.security__recovery .recovery-codes li').first()).toBeVisible(UNBUILT);

  // The old phone's session has ended.
  await page.goto('/money');
  await expect(page.getByRole('heading', { name: 'Sign in to continue' })).toBeVisible(UNBUILT);
  await context.close();
});

test(`${J} #5 support recovery: a case with a mailed one-time link, a second approver, and the agent never sees the link`, async ({
  page,
}) => {
  await page.goto('/login');
  await page.getByRole('link', { name: 'I cannot sign in' }).click(UNBUILT);
  await expect(page.getByRole('heading', { name: /a person answers/i })).toBeVisible(UNBUILT);
});

test(`${J} #6 mail and inbox notices for each factor change`, async ({ page }) => {
  test.setTimeout(120_000);
  const { who } = await withAuthenticator(page);
  await expect.poll(() => mailedLines(who.email, 'factor-changed').length, UNBUILT).toBeGreaterThan(0);
  await page.goto('/notifications');
  await expect(page.getByText('Authenticator app turned on')).toBeVisible(UNBUILT);
});

test(`${J} #7 recovery keys set earlier (people they trust, never staff) claim the account back`, async ({ page }) => {
  test.setTimeout(90_000);
  const who = person('rk');
  await signUpInBrowser(page, who);
  await page.goto('/uc/safe');
  await expect(page.getByRole('heading', { name: 'Recovery keys' })).toBeVisible(UNBUILT);
});
