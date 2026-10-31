import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { test, expect } from './journey.mjs';
import { ROOT, signUpInBrowser } from './stack.mjs';
import { PASSKEY_ORIGIN, addAuthenticator, nextCode } from './identity-factors.mjs';

// J-wallet-04 #7, identity's half (W-withdraw-09), in the running app: the customer security lock on Security. Locking
// is at once; a password change is refused while it holds; an unlock is asked for with a fresh authenticator code and
// ends only after the stack's LOCAL TEST wait; a reload shows the same end time; "Keep it locked" withdraws the request.
// The address book and withdraw refusals are svc-bank's half, in J-wallet-04.pw.mjs; #7 passes when both halves do.
const J = 'J-wallet-04';

test.describe.configure({ mode: 'default' });
test.use({ baseURL: PASSKEY_ORIGIN });

test(`${J} #7 (identity's half): the security lock turns on at once, stops a password change, and unlocks only after the wait`, async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { totp } = await import(path.join(ROOT, 'services/svc-identity/dist/auth/totp.js'));
  const handle = `sl${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
  const who = { handle, email: `${handle}@local-test.invalid`, password: `TEST-${randomBytes(9).toString('base64url')}-9a` };
  await signUpInBrowser(page, who);

  await page.goto('/uc/safe');
  const card = page.getByTestId('security__lock');
  await expect(card).toContainText('The lock is off.');
  await card.getByRole('button', { name: 'Turn on the lock' }).click();
  await expect(card).toContainText('Password changes and resets stop at once.');
  await expect(card).toContainText('To ask to unlock later you need your authenticator app or a passkey');
  await expect(card).toContainText('does not stop them');
  await card.getByRole('button', { name: 'Turn it on now' }).click();
  await expect(card.getByTestId('notice')).toHaveText('The lock is on.');
  await expect(card.getByTestId('security__lock-state')).toContainText('The lock is on since');

  // While it holds, the password does not change, and the page says why.
  const password = page.getByTestId('security__password');
  await password.getByLabel('Current password').fill(who.password);
  const next = `TEST-${randomBytes(9).toString('base64url')}-7b`;
  await password.getByLabel('New password', { exact: true }).fill(next);
  await password.getByLabel('Repeat the new password').fill(next);
  await password.getByRole('button', { name: 'Change password' }).click();
  await expect(password).toContainText('Your security lock is on, so the password cannot be changed');
  await expect(password).not.toContainText('Your password was changed');

  // Asking to unlock needs a fresh second step; the lock still holds, with an end time identity fixed.
  const { secret, step } = await addAuthenticator(page, totp);
  await page.goto('/uc/safe');
  await card.getByRole('button', { name: 'Ask to unlock' }).click();
  const { code } = await nextCode(totp, secret, step);
  await card.getByLabel('6-digit code from your authenticator app').fill(code);
  await card.getByRole('button', { name: 'Ask with code' }).click();
  await expect(card.getByTestId('notice')).toContainText('Unlock asked for. The lock ends');
  const state = card.getByTestId('security__lock-state');
  await expect(state).toContainText('The lock ends');
  const shown = await state.textContent();

  // A reload shows the same end time: nothing in the page carries or shortens it.
  await page.reload();
  await expect(state).toHaveText(shown ?? '');
  await card.getByRole('button', { name: 'Keep it locked' }).click();
  await expect(card.getByTestId('notice')).toHaveText('Your unlock request is withdrawn. The lock stays on.');
  await expect(state).toContainText('The lock is on since');
  await expect(card.getByRole('button', { name: 'Ask to unlock' })).toBeVisible();
});
