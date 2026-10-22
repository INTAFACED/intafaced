import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { ROOT, signUpInBrowser } from './stack.mjs';
import { PASSKEY_ORIGIN, addAuthenticator, addPasskey, nextCode, virtualAuthenticator } from './identity-factors.mjs';

// J-identity-04, in the running app (docs/roadmap/journeys.json): I turn on two-factor sign-in and check my Security
// centre. Tests titled "J-identity-04 #<n>" prove a whole step; the others prove part of one and say which.
const J = 'J-identity-04';

test.describe.configure({ mode: 'default' });
test.use({ baseURL: PASSKEY_ORIGIN });

function person(prefix) {
  const handle = `${prefix}${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
  return { handle, email: `${handle}@local-test.invalid`, password: `TEST-${randomBytes(9).toString('base64url')}-9a` };
}

test(`${J}, part of #2 and #3: with an authenticator on, adding a passkey asks to sign in again with the code, then adds`, async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { totp } = await import(path.join(ROOT, 'services/svc-identity/dist/auth/totp.js'));
  const who = person('sp');
  await virtualAuthenticator(page);
  await signUpInBrowser(page, who);
  const { secret, step } = await addAuthenticator(page, totp);

  // This browser's sign-in has not passed the new second factor, so the service refuses before any change.
  await page.goto('/uc/safe');
  await page.getByRole('button', { name: 'Add passkey' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Add passkey' }).click();
  const refusal = page.locator('.failure');
  await expect(refusal).toContainText('Confirm it is you');
  await expect(refusal).toContainText('Confirm it is you with your authenticator code or a passkey');
  await expect(refusal).not.toContainText('Outcome not confirmed');
  await expect(page.locator('.security__passkeys')).toContainText('No passkeys yet');

  // Its link signs in again with the code and comes back to Security, where the passkey now adds.
  await refusal.getByRole('link', { name: 'Sign in again' }).click();
  await expect(page).toHaveURL(/\/login\?redirect=%2Fuc%2Fsafe/);
  const { code } = await nextCode(totp, secret, step);
  await page.fill('input[name=totp]', code);
  await page.fill('input[name=identifier]', who.email);
  await page.fill('input[name=password]', who.password);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page).toHaveURL(/\/uc\/safe$/);
  await addPasskey(page);
});

test(`${J}, part of #2: the refused passkey add goes ahead after the authenticator code in "Confirm it's you", without signing in again`, async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { totp } = await import(path.join(ROOT, 'services/svc-identity/dist/auth/totp.js'));
  const who = person('su');
  await virtualAuthenticator(page);
  await signUpInBrowser(page, who);
  const { secret, step } = await addAuthenticator(page, totp);

  await page.goto('/uc/safe');
  await page.getByRole('button', { name: 'Add passkey' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Add passkey' }).click();
  const refusal = page.locator('.failure');
  await expect(refusal).toContainText('Confirm it is you');

  // The sheet asks for a fresh factor; the code buys one change, and the same add runs again on this page.
  await refusal.getByRole('button', { name: 'Confirm it is you' }).click();
  const sheet = page.getByRole('dialog', { name: /confirm it’s you/i });
  await expect(sheet).toContainText('This changes how you sign in');
  const { code } = await nextCode(totp, secret, step);
  await sheet.getByLabel('Authenticator code or recovery code').fill(code);
  await sheet.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(sheet).toBeHidden();
  await expect(page).toHaveURL(/\/uc\/safe$/);
  await expect(page.locator('.security__passkeys')).not.toContainText('No passkeys yet');
  await expect(page.locator('.failure')).toHaveCount(0);
});
