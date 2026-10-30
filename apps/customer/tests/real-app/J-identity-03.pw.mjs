import { randomBytes } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { mailedLines, signUpInBrowser } from './stack.mjs';

// J-identity-03, in the running app (docs/roadmap/journeys.json): I forgot my password or my handle. One test per step,
// titled "J-identity-03 #<n>". Every person is a TEST person on the local stack, signed up through the browser
// (J-identity-01), and every mail is read from the stack's LOCAL-TEST outbox as the person would read their inbox. The
// stack's TEST owner values: a reset code lives ten minutes and three wrong codes lock the reset.
const J = 'J-identity-03';

test.describe.configure({ mode: 'default' });

function person(prefix = 'fp') {
  const handle = `${prefix}${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
  return { handle, email: `${handle}@local-test.invalid`, password: `TEST-${randomBytes(9).toString('base64url')}-9a` };
}

/** A fresh TEST account, signed up in its own browser context, which stays open and signed in (an "other device"). */
async function account(browser) {
  const who = person();
  const device = await browser.newContext();
  const page = await device.newPage();
  await signUpInBrowser(page, who);
  return { who, device, page };
}

/** The reset codes mailed to `email`, oldest first. The mail carries the code in its link. */
function resetCodes(email) {
  return mailedLines(email, 'password-reset')
    .map((line) => /code=([^\s&]+)/.exec(line)?.[1])
    .filter(Boolean)
    .map(decodeURIComponent);
}

async function nextResetCode(email, seen) {
  await expect.poll(() => resetCodes(email).length, { timeout: 20_000 }).toBeGreaterThan(seen);
  return resetCodes(email).at(-1);
}

async function askReset(page, email) {
  await page.goto('/findPwd');
  await page.getByLabel('Email address', { exact: true }).fill(email);
  await page.getByRole('button', { name: 'Send reset code' }).click();
  await expect(page.getByLabel('Code from the email')).toBeVisible();
  return page.getByRole('status').filter({ hasText: 'a code is on its way' }).innerText();
}

/**
 * Send the reset form and wait until it is no longer busy. The submit clears the last message at once (a discrete
 * React event), so the next check reads this attempt's message, never the previous one.
 */
async function submitReset(page, code, password, confirm = password) {
  await page.getByLabel('Code from the email').fill(code);
  await page.getByLabel('New password', { exact: true }).fill(password);
  await page.getByLabel('Repeat the new password').fill(confirm);
  await page.getByRole('button', { name: 'Save new password' }).click();
  await expect(page.getByRole('button', { name: 'Saving…' })).toHaveCount(0);
}

test(`${J} #1 the find-password page answers the same whether or not the account exists`, async ({ page, browser }) => {
  const { who, device } = await account(browser);
  await device.close();
  const seen = resetCodes(who.email).length;
  const unknown = `nobody-${who.handle}@local-test.invalid`;
  const forUnknown = await askReset(page, unknown);
  const forKnown = await askReset(page, who.email);
  expect(forUnknown).toBe(forKnown);
  // Only the real account is mailed. The relay sends in order, so once the later request's code is out, the earlier
  // unknown address's job has been handled too: nothing reached it (the stack keeps no-account notices off).
  await nextResetCode(who.email, seen);
  expect(mailedLines(unknown, 'password-reset')).toHaveLength(0);
  expect(mailedLines(unknown, 'reset-no-account')).toHaveLength(0);
});

test(`${J} #2 the code step: three wrong codes lock the reset, and a used code is refused`, async ({ page, browser }) => {
  const { who, device } = await account(browser);
  await device.close();
  const seen = resetCodes(who.email).length;
  await askReset(page, who.email);
  const code = await nextResetCode(who.email, seen);
  const fresh = `TEST-${randomBytes(9).toString('base64url')}-new`;
  for (let i = 0; i < 3; i++) {
    await submitReset(page, `wrong-${i}-${code}`, fresh);
    await expect(page.getByRole('alert')).toContainText(i < 2 ? 'That code is not valid' : 'Too many attempts');
  }
  // Locked: even the right code is refused now.
  await submitReset(page, code, fresh);
  await expect(page.getByRole('alert')).toContainText('Too many attempts');

  // A second reset, used once, then refused.
  const other = await account(browser);
  await other.device.close();
  const before = resetCodes(other.who.email).length;
  await askReset(page, other.who.email);
  const good = await nextResetCode(other.who.email, before);
  await submitReset(page, good, fresh);
  await expect(page.getByRole('status').filter({ hasText: 'Your password has been changed' })).toBeVisible();
  await askReset(page, other.who.email);
  await submitReset(page, good, `${fresh}-again`);
  await expect(page.getByRole('alert')).toContainText('That code is not valid');
});

test(`${J} #3 the new password follows the rule: a short one is refused with the reason`, async ({ page, browser }) => {
  const { who, device } = await account(browser);
  await device.close();
  const seen = resetCodes(who.email).length;
  await askReset(page, who.email);
  const code = await nextResetCode(who.email, seen);
  await submitReset(page, code, 'short');
  await expect(page.getByRole('alert')).toContainText('Use at least 12 characters');
  // A password on the owner's breached list is refused by name (I-signin-sessions-04). Fails fast until it lands.
  await submitReset(page, code, 'TEST-breached-password-0001');
  await expect(page.getByRole('alert')).toContainText('known from a data breach', { timeout: 5_000 });
});

test(`${J} #4 signs in with the new password; the old one fails; every other device is signed out`, async ({ page, browser }) => {
  const { who, device, page: other } = await account(browser);
  const seen = resetCodes(who.email).length;
  await askReset(page, who.email);
  const code = await nextResetCode(who.email, seen);
  const fresh = `TEST-${randomBytes(9).toString('base64url')}-new`;
  await submitReset(page, code, fresh);
  await expect(page.getByRole('status').filter({ hasText: 'every device that was signed in has been signed out' })).toBeVisible();

  await page.getByRole('button', { name: 'Go to sign in' }).click();
  await page.fill('input[name=identifier]', who.email);
  await page.fill('input[name=password]', who.password);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page.getByTestId('failure')).toContainText('Those details did not work');
  await page.fill('input[name=password]', fresh);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page).not.toHaveURL(/\/login/);

  // The device that was signed in before the reset is signed out.
  await other.goto('/money');
  await expect(other.getByRole('heading', { name: 'Sign in to continue' })).toBeVisible();
  await device.close();
});

test(`${J} #5 a forgotten handle is mailed to the stored address; the page never says whether the account exists`, async ({
  page,
  browser,
}) => {
  const { who, device } = await account(browser);
  await device.close();
  const ask = async (email) => {
    await page.goto('/findPwd');
    await page.getByRole('button', { name: 'I forgot my handle' }).click();
    await page.getByLabel('Email address for your handle').fill(email);
    await page.getByRole('button', { name: 'Email me my handle' }).click();
    return page.getByRole('status').filter({ hasText: 'its handle is on its way' }).innerText();
  };
  const forKnown = await ask(who.email);
  const forUnknown = await ask(`nobody-${who.handle}@local-test.invalid`);
  expect(forUnknown).toBe(forKnown);
  await expect
    .poll(() => mailedLines(who.email, 'handle-recovery').some((line) => line.includes(`handle=${who.handle}`)), { timeout: 20_000 })
    .toBe(true);
});

test(`${J} #6 a "your password was changed" notice by mail and in the inbox`, async ({ page, browser }) => {
  const { who, device } = await account(browser);
  await device.close();
  const seen = resetCodes(who.email).length;
  await askReset(page, who.email);
  const code = await nextResetCode(who.email, seen);
  const changed = `TEST-${randomBytes(9).toString('base64url')}-new`;
  await submitReset(page, code, changed);
  await expect(page.getByRole('status').filter({ hasText: 'Your password has been changed' })).toBeVisible();
  // The security notice (I-signin-sessions-08). Fails fast until it lands.
  await expect.poll(() => mailedLines(who.email, 'password-changed').length, { timeout: 5_000 }).toBeGreaterThan(0);
  // And in the inbox: signed in with the new password, the security notice names the password change and links to
  // Security. It follows the event svc-identity's outbox relay publishes within a few seconds: reload until it shows.
  await page.goto('/login');
  await page.fill('input[name=identifier]', who.email);
  await page.fill('input[name=password]', changed);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page).not.toHaveURL(/\/login/);
  // The row itself: its title, its body and its link to Security.
  const row = page.getByTestId('nf-row').filter({ has: page.getByTestId('nf-title').getByText('Password changed', { exact: true }) });
  await expect(async () => {
    await page.goto('/notifications');
    await expect(row).toHaveCount(1, { timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await expect(row.getByTestId('nf-body')).toHaveText(
    'The password of your account was changed. If this was not you, reset it now, open Security, sign out everywhere and contact Support.',
  );
  await expect(row).toHaveAttribute('href', '/uc/safe');
});
