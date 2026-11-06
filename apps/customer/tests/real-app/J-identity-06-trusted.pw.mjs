import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { test, expect } from './journey.mjs';
import { ROOT, mailedCodes, nextMailedCode, signUpInBrowser } from './stack.mjs';
import { addAuthenticator, nextCode } from './identity-factors.mjs';

// J-identity-06 #5, in the running app (docs/roadmap/journeys.json): I review my trusted devices and remove one, and
// the removed device asks for authorisation again at its next sign-in. Tests titled "J-identity-06 #<n>" prove a whole
// step. The account is signed up in this TEST browser (trusted from its first sign-in) and approves a second browser
// that has never been used, by the code mailed to the account (the stack's LOCAL TEST outbox).
const J = 'J-identity-06';

function person(prefix) {
  const handle = `${prefix}${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
  return { handle, email: `${handle}@local-test.invalid`, password: `TEST-${randomBytes(9).toString('base64url')}-9a` };
}

async function fillSignIn(page, who) {
  await page.fill('input[name=identifier]', who.email);
  await page.fill('input[name=password]', who.password);
  await page.getByRole('button', { name: /^sign in$/i }).click();
}

const trustedCard = (page) => page.locator('section.security__trusted-devices');

test(`${J} #5 reviews trusted devices and removes one: the removed device asks for authorisation again at its next sign-in`, async ({
  browser,
  page,
}) => {
  test.setTimeout(240_000);
  const { totp } = await import(path.join(ROOT, 'services/svc-identity/dist/auth/totp.js'));
  const who = person('td');
  await signUpInBrowser(page, who);

  // A browser this account has never signed in on: it is asked to authorise the device, and the mailed code does.
  const freshContext = await browser.newContext();
  await freshContext.clearCookies();
  const fresh = await freshContext.newPage();
  try {
    const seen = mailedCodes(who.email, 'new-device-code').length;
    await fresh.goto('/login');
    await fillSignIn(fresh, who);
    await expect(fresh.getByRole('heading', { name: 'Authorise this device' })).toBeVisible({ timeout: 10_000 });
    await fresh.getByLabel('Device code from the email').fill(await nextMailedCode(who.email, seen, 20_000, 'new-device-code'));
    await fresh.getByRole('button', { name: 'Approve this device' }).click();
    await expect(fresh).not.toHaveURL(/\/login/, { timeout: 10_000 });

    // The first browser confirms who it is with an authenticator, then reviews the list: both browsers, this one marked.
    let { secret, step } = await addAuthenticator(page, totp);
    await page.goto('/uc/safe');
    const card = trustedCard(page);
    await expect(card.getByRole('heading', { name: 'Trusted devices' })).toBeVisible();
    const rows = card.getByRole('listitem').filter({ has: page.getByRole('button', { name: /^Remove / }) });
    await expect(rows).toHaveCount(2);
    await expect(rows.filter({ hasText: 'This device' })).toHaveCount(1);
    const other = rows.filter({ hasNotText: 'This device' });
    await expect(other).toHaveCount(1);
    await expect(other).toContainText(/Trusted /);

    // Removes the other browser, confirmed with the authenticator.
    await other.getByRole('button', { name: /^Remove / }).click();
    await expect(card.getByText('It stops being trusted and every sign-in on it ends.')).toBeVisible();
    let code;
    ({ code, step } = await nextCode(totp, secret, step));
    await card.getByLabel('6-digit code from your authenticator app').fill(code);
    const removed = page.waitForResponse((r) => new URL(r.url()).pathname.endsWith('/trustedDevices.remove'));
    await card.getByRole('button', { name: 'Confirm with code' }).click();
    expect((await removed).status()).toBe(200);
    await expect(card.getByRole('status').filter({ hasText: /^Device removed\./ })).toBeVisible();
    await expect(rows).toHaveCount(1);
    await expect(rows).toContainText('This device');

    // The removed browser's sign-in has ended.
    await fresh.goto('/uc/safe');
    await expect(fresh.getByRole('heading', { name: 'Sign in to continue' })).toBeVisible();

    // At its next sign-in, after the password and the authenticator code, it is asked to authorise the device again.
    await fresh.goto('/login');
    ({ code, step } = await nextCode(totp, secret, step));
    await fresh.fill('input[name=totp]', code);
    await fillSignIn(fresh, who);
    await expect(fresh.getByRole('heading', { name: 'Authorise this device' })).toBeVisible({ timeout: 10_000 });
    await expect(fresh).toHaveURL(/\/login/);

    // This browser stays trusted and signed in.
    await page.reload();
    await expect(trustedCard(page).getByRole('heading', { name: 'Trusted devices' })).toBeVisible();
  } finally {
    await freshContext.close();
  }
});
