import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { ROOT, signUpInBrowser, staffFreeze } from './stack.mjs';
import { PASSKEY_ORIGIN, addAuthenticator, addPasskey, forgetSession, nextCode, virtualAuthenticator } from './identity-factors.mjs';

// J-identity-02, in the running app (docs/roadmap/journeys.json): sign in, on a new device too. One test per step this
// build serves, titled "J-identity-02 #<n>". Every person here is a TEST person on the local stack, signed up through
// the browser (J-identity-01) with a fresh TEST password kept only in memory for the run.
const J = 'J-identity-02';

test.describe.configure({ mode: 'default' });

function person(prefix = 'js') {
  const handle = `${prefix}${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
  return { handle, email: `${handle}@local-test.invalid`, password: `TEST-${randomBytes(9).toString('base64url')}-9a` };
}

/** A fresh TEST account, signed up in a throwaway browser context so the test's own page starts signed out. */
async function account(browser) {
  const who = person();
  const context = await browser.newContext();
  await signUpInBrowser(await context.newPage(), who);
  await context.close();
  return who;
}

async function fillSignIn(page, identifier, password) {
  await page.fill('input[name=identifier]', identifier);
  await page.fill('input[name=password]', password);
  await page.getByRole('button', { name: /^sign in$/i }).click();
}

test(`${J} #1 signs in with the email or the handle and a password; an unknown name and a wrong password read the same`, async ({
  page,
  browser,
}) => {
  const who = await account(browser);
  await page.goto('/login');
  const refusal = page.locator('.failure');
  await fillSignIn(page, `nobody-${who.handle}@local-test.invalid`, who.password);
  await expect(refusal).toContainText('Those details did not work');
  await expect(refusal).toContainText('Check what you typed');
  const unknown = await refusal.textContent();
  await page.reload();
  await fillSignIn(page, who.email, `${who.password}-wrong`);
  await expect(refusal).toHaveText(unknown);
  await fillSignIn(page, who.handle, who.password);
  await expect(page).not.toHaveURL(/\/login/);
});

test(`${J} #8 a private address while signed out goes to sign-in and back to that exact room; a reload keeps the sign-in`, async ({
  page,
  browser,
}) => {
  const who = await account(browser);
  const room = '/money?asset=BTC';
  await page.goto(room);
  // The room keeps its place and says why it is empty; its sign-in link carries the way back.
  await expect(page.getByRole('heading', { name: 'Sign in to continue' })).toBeVisible();
  await page.getByRole('main').getByRole('link', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/login\?redirect=/);
  await fillSignIn(page, who.email, who.password);
  await expect(page).toHaveURL(/\/money\?asset=BTC$/);
  await page.reload();
  await expect(page).toHaveURL(/\/money\?asset=BTC$/);
  await expect(page.locator('input[name=password]')).toHaveCount(0);
});

test(`${J} #2 several wrong passwords give a typed lockout with the minutes left`, async ({ page, browser }) => {
  const who = await account(browser);
  await page.goto('/login');
  const refusal = page.locator('.failure');
  // The stack's TEST owner value: ten wrong passwords in fifteen minutes, then a pause.
  for (let i = 0; i < 10; i++) {
    await fillSignIn(page, who.email, `${who.password}-wrong-${i}`);
    await expect(refusal).toContainText('Those details did not work');
    await page.reload();
  }
  await fillSignIn(page, who.email, who.password);
  // Even the right password waits out the pause, and the page says how long.
  await expect(page.getByRole('alert')).toContainText(/Too many tries\. You can try again in \d+ min\./);
  await expect(page).toHaveURL(/\/login/);
});

test(`${J} #7 a frozen account is named after the right password, with the way to support; a wrong password names nothing`, async ({
  page,
  browser,
}) => {
  const who = await account(browser);
  await staffFreeze(who);
  await page.goto('/login');
  const refusal = page.locator('.failure');
  // A wrong password learns nothing about the account's state.
  await fillSignIn(page, who.email, `${who.password}-wrong`);
  await expect(refusal).toContainText('Those details did not work');
  await expect(refusal).not.toContainText('frozen');
  await page.reload();
  await fillSignIn(page, who.email, who.password);
  await expect(page.getByRole('alert')).toContainText('This account is frozen.');
  await expect(page.getByRole('alert')).toContainText('Only support can lift a freeze');
  await expect(page).toHaveURL(/\/login/);
  await page.getByRole('alert').getByRole('link', { name: 'Contact support' }).click();
  await expect(page).toHaveURL(/\/help/);
});

test.describe('passkeys', () => {
  test.use({ baseURL: PASSKEY_ORIGIN });

  test(`${J} #4 passkey sign-in by handle; an unknown handle and one without passkeys look the same until the prompt`, async ({
    page,
    browser,
  }) => {
    const bare = await account(browser);
    const who = person('pk');
    await virtualAuthenticator(page);
    await signUpInBrowser(page, who);
    await addPasskey(page);
    await forgetSession(page);

    const answers = [];
    for (const identifier of [`nobody-${who.handle}`, bare.handle]) {
      await page.goto('/login');
      await page.fill('input[name=identifier]', identifier);
      const options = page.waitForResponse((res) => res.url().includes('webauthn.authOptions'));
      await page.getByRole('button', { name: 'Use a passkey' }).click();
      const body = (await (await options).json()).result.data;
      // Both get a challenge and a list of credentials, so the browser prompt opens for each.
      expect(body.challenge).toBeTruthy();
      expect(body.allowCredentials.length).toBeGreaterThan(0);
      await expect(page.locator('.failure')).toBeVisible();
      answers.push(await page.locator('.failure').textContent());
    }
    expect(answers[1]).toBe(answers[0]);

    await page.goto('/login');
    await page.fill('input[name=identifier]', who.handle);
    await page.getByRole('button', { name: 'Use a passkey' }).click();
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page.locator('input[name=password]')).toHaveCount(0);
  });

  test(`${J} #6 a second step: the authenticator code or a passkey; a code used twice is refused`, async ({ page, browser }) => {
    test.setTimeout(150_000);
    const { totp } = await import(path.join(ROOT, 'services/svc-identity/dist/auth/totp.js'));
    const who = person('mf');
    await virtualAuthenticator(page);
    await signUpInBrowser(page, who);
    await addPasskey(page);
    // With a passkey on the account, changing its factors needs a session that passed one: sign in with it.
    await forgetSession(page);
    await page.goto('/login');
    await page.fill('input[name=identifier]', who.handle);
    await page.getByRole('button', { name: 'Use a passkey' }).click();
    await expect(page).not.toHaveURL(/\/login/);
    let { secret, step } = await addAuthenticator(page, totp);

    const fresh = await browser.newContext({ baseURL: PASSKEY_ORIGIN });
    const other = await fresh.newPage();
    await other.goto('/login');
    await fillSignIn(other, who.email, who.password);
    // The right password alone asks for the second step, on this page.
    await expect(other.getByRole('alert')).toContainText('Enter it again with the six-digit code from your authenticator app');
    await expect(other).toHaveURL(/\/login/);
    let used;
    ({ code: used, step } = await nextCode(totp, secret, step));
    await other.fill('input[name=totp]', used);
    await fillSignIn(other, who.email, who.password);
    await expect(other).not.toHaveURL(/\/login/);
    await fresh.close();

    // The same code again, from another browser, is refused.
    const again = await browser.newContext({ baseURL: PASSKEY_ORIGIN });
    const third = await again.newPage();
    await third.goto('/login');
    await third.fill('input[name=totp]', used);
    await fillSignIn(third, who.email, who.password);
    await expect(third.getByRole('alert')).toContainText('That code did not work. Every code works only once');
    await expect(third).toHaveURL(/\/login/);
    await again.close();

    // A passkey is a second step on its own.
    await forgetSession(page);
    await page.goto('/login');
    await page.fill('input[name=identifier]', who.handle);
    await page.getByRole('button', { name: 'Use a passkey' }).click();
    await expect(page).not.toHaveURL(/\/login/);
  });
});
