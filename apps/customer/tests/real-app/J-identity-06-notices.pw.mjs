import { randomBytes } from 'node:crypto';
import { test, expect } from './journey.mjs';
import { mailedCodes, mailedLines, nextMailedCode, signUpInBrowser } from './stack.mjs';

// J-identity-06 #7, in the running app (docs/roadmap/journeys.json): I open Notifications and see a "new device
// sign-in" notice and a "password changed" notice, each sent once, and the email still goes while text messages are
// off. Tests titled "J-identity-06 #<n>" prove a whole step. The account is signed up in this TEST browser, approves a
// browser it never used by the mailed code (the stack's LOCAL TEST outbox), then changes its password in Security.
const J = 'J-identity-06';

function person(prefix) {
  const handle = `${prefix}${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
  return { handle, email: `${handle}@local-test.invalid`, password: `TEST-${randomBytes(9).toString('base64url')}-9a` };
}

const newDeviceMails = (email) => mailedLines(email, 'factor-changed').filter((line) => line.includes(' change=new_device'));

test(`${J} #7 Notifications holds a "new device sign-in" notice and a "password changed" notice, each sent once; the email still goes when text messages are off`, async ({
  browser,
  page,
}) => {
  test.setTimeout(240_000);
  const who = person('nd');
  await signUpInBrowser(page, who);
  expect(newDeviceMails(who.email), 'signing up on the first browser is not a new-device sign-in').toEqual([]);

  // A browser the account never used signs in, approved by the mailed code.
  const freshContext = await browser.newContext();
  await freshContext.clearCookies();
  const fresh = await freshContext.newPage();
  try {
    const seen = mailedCodes(who.email, 'new-device-code').length;
    await fresh.goto('/login');
    await fresh.fill('input[name=identifier]', who.email);
    await fresh.fill('input[name=password]', who.password);
    await fresh.getByRole('button', { name: /^sign in$/i }).click();
    await expect(fresh.getByRole('heading', { name: 'Authorise this device' })).toBeVisible({ timeout: 10_000 });
    await fresh.getByLabel('Device code from the email').fill(await nextMailedCode(who.email, seen, 20_000, 'new-device-code'));
    await fresh.getByRole('button', { name: 'Approve this device' }).click();
    await expect(fresh).not.toHaveURL(/\/login/, { timeout: 10_000 });
  } finally {
    await freshContext.close();
  }
  // The email went: one new-device notice to the account's address.
  await expect.poll(() => newDeviceMails(who.email).length, { timeout: 20_000 }).toBe(1);

  // The password changes in Security, on the first browser.
  const next = `TEST-${randomBytes(9).toString('base64url')}-7n`;
  await page.goto('/uc/safe');
  const password = page.getByTestId('security__password');
  await password.getByLabel('Current password').fill(who.password);
  await password.getByLabel('New password', { exact: true }).fill(next);
  await password.getByLabel('Repeat the new password').fill(next);
  await password.getByRole('button', { name: 'Change password' }).click();
  await expect(password).toContainText('Your password was changed.');
  await expect.poll(() => mailedLines(who.email, 'password-changed').length, { timeout: 20_000 }).toBe(1);

  // Notifications: both notices, once each, linking to Security. They follow the events identity's outbox relay
  // publishes within seconds, so the inbox is reloaded until both show.
  const titled = (title) => page.getByTestId('nf-row').filter({ has: page.getByTestId('nf-title').getByText(title, { exact: true }) });
  await expect(async () => {
    await page.goto('/notifications');
    await expect(titled('New device sign-in')).toHaveCount(1, { timeout: 2_000 });
    await expect(titled('Password changed')).toHaveCount(1, { timeout: 2_000 });
  }).toPass({ timeout: 45_000 });
  await expect(titled('New device sign-in').getByTestId('nf-body')).toHaveText(
    'A new device was approved and signed in to your account. If this was not you, open Security, remove the device, sign out everywhere and contact Support.',
  );
  await expect(titled('New device sign-in')).toHaveAttribute('href', '/uc/safe');
  await expect(titled('Password changed')).toHaveAttribute('href', '/uc/safe');

  // Sent once: after the relay has had time to publish again, still one of each, in the inbox and by mail.
  await page.waitForTimeout(5_000);
  await page.goto('/notifications');
  await expect(titled('New device sign-in')).toHaveCount(1);
  await expect(titled('Password changed')).toHaveCount(1);
  expect(newDeviceMails(who.email)).toHaveLength(1);
  expect(mailedLines(who.email, 'password-changed')).toHaveLength(1);

  // Text messages are off on this platform, and the security notices went by email all the same (above).
  await page.goto('/notifications?view=settings');
  const sms = page.getByRole('switch', { name: 'Security, Text message' });
  await expect(sms).toBeDisabled();
  await expect(page.getByRole('cell').filter({ has: sms })).toContainText('Not connected on this platform, so nothing can be sent here.');
});
