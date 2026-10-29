import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { ROOT, api, signOutBrowser, signUpInBrowser } from './stack.mjs';
import { addAuthenticator, nextCode } from './identity-factors.mjs';

// J-identity-11, in the running app (docs/roadmap/journeys.json): I freeze my own account and later reactivate it.
// One test per step this build serves, titled "J-identity-11 #<n>". Every person here is a TEST person on the local
// stack, signed up through the browser (J-identity-01) with a fresh TEST password kept only in memory for the run.
const J = 'J-identity-11';

test.describe.configure({ mode: 'default' });

function person(prefix = 'jf') {
  const handle = `${prefix}${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
  return { handle, email: `${handle}@local-test.invalid`, password: `TEST-${randomBytes(9).toString('base64url')}-9a` };
}

const totpLib = () => import(path.join(ROOT, 'services/svc-identity/dist/auth/totp.js'));

/** Freezes the person's own account from Security with their password; every session ends. Returns when it was asked. */
async function freezeOwn(page, who) {
  await page.goto('/uc/safe');
  const card = page.getByTestId('security__card').filter({ has: page.getByRole('heading', { name: 'Freeze your account' }) });
  await card.getByLabel('Your password').fill(who.password);
  // Taken before the click, so it is never later than the freeze the service records.
  const frozenAt = Date.now();
  await card.getByRole('button', { name: 'Freeze my account' }).click();
  // The freeze ends this session too: the room shows the frozen card until its next read finds the session gone, then
  // drops to signed out. Either is the answer; the sign-in after it proves the freeze.
  await expect(
    page.getByRole('heading', { name: 'You froze this account' }).or(page.getByRole('heading', { name: 'Sign in to continue' })),
  ).toBeVisible();
  return frozenAt;
}

/** Signs in again through /login to an account its owner froze; the sign-in lands on that freeze. */
async function signInFrozen(page, who) {
  await page.goto('about:blank');
  await signOutBrowser(page.context());
  await page.goto('/login');
  await page.fill('input[name=identifier]', who.email);
  await page.fill('input[name=password]', who.password);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  const frozen = page.getByTestId('frozen-by-you');
  await expect(frozen).toBeVisible();
  return frozen;
}

const ACTIONS = [
  'Sign in',
  'Trade',
  'Create API keys',
  'Change your password',
  'Change your sign-in methods',
  'Reset your password',
  'Reset your second factor',
  'Add recovery keys or change their plan',
  'Add a withdrawal address',
  'Start a send to a withdrawal address',
];

test(`${J} #1 Account status lists what I can still do and what I cannot; an active account blocks nothing`, async ({ page }) => {
  await signUpInBrowser(page, person());
  await page.goto('/uc/account');
  const status = page.getByTestId('account-status');
  await expect(status.getByRole('heading', { name: 'Account status' })).toBeVisible();
  await expect(status.getByTestId('account-status__state')).toHaveAttribute('data-state', 'active');
  await expect(status.getByTestId('account-status__state')).toHaveText('Your account is active. Nothing is restricted.');
  await expect(status.getByTestId('account-status__can').locator('li')).toHaveText(ACTIONS);
  await expect(status.getByTestId('account-status__cannot').locator('li')).toHaveText(['Nothing']);
  await expect(status.getByTestId('account-status__restrictions')).toHaveCount(0);

  // A restriction shows in both lists with its reason and how it ends: the owner's own security lock.
  await page.goto('/uc/safe');
  await page.getByRole('button', { name: 'Turn on the lock' }).click();
  await page.getByRole('button', { name: 'Turn it on now' }).click();
  await expect(page.getByText('The lock is on.').first()).toBeVisible();
  await page.goto('/uc/account');
  await expect(status.getByTestId('account-status__state')).toHaveAttribute('data-state', 'restricted');
  const lock = status.getByTestId('account-status__restrictions').locator('li[data-kind="security_lock"]');
  await expect(lock).toContainText('Security lock');
  await expect(lock).toContainText('Reason: you turned it on.');
  await expect(lock).toContainText('It holds until you ask to unlock it in Security.');
  await expect(status.getByTestId('account-status__cannot').locator('li')).toHaveText(ACTIONS.slice(3));
  await expect(status.getByTestId('account-status__can').locator('li')).toHaveText(['Sign in', 'Trade', 'Create API keys']);
});

test(`${J} #3 Signing in again after freezing lands on a typed "frozen by you" page with the lift path, not a generic error`, async ({
  page,
}) => {
  test.setTimeout(120_000);
  const who = person('jg');
  await signUpInBrowser(page, who);
  await freezeOwn(page, who);

  // The sign-in succeeds and lands on the person's own freeze, typed from identity's account status, with no refusal.
  const frozen = await signInFrozen(page, who);
  await expect(frozen).toHaveAttribute('data-state', 'frozen_self');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('You froze this account');
  await expect(frozen.getByTestId('frozen-by-you__since')).toHaveText(/^Frozen on .+\.$/);
  // The stack's TEST wait (IDENTITY_SELF_FREEZE_LIFT_WAIT_SECONDS=20) has not passed, so the page says from when.
  const lift = frozen.getByTestId('frozen-by-you__lift');
  await expect(lift).toHaveAttribute('data-lift', 'liftAt');
  await expect(lift).toHaveText(/^You can reactivate it yourself from .+, in Security, with your authenticator code or a passkey\.$/);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByTestId('failure')).toHaveCount(0);

  // The page states what identity holds: the same account reads frozen by its owner, with one self freeze.
  const own = await api(who);
  const read = await own.get('/api/identity/trpc/accountStatus.mine');
  expect(read.status).toBe(200);
  expect(read.body.result.data.state).toBe('frozen_self');
  expect(read.body.result.data.restrictions.map((restriction) => restriction.kind)).toEqual(['self_freeze']);
  // What the page says the freeze stops is exactly what identity's guard refuses for it.
  const stops = await frozen
    .getByTestId('frozen-by-you__stops')
    .locator('li')
    .evaluateAll((items) => items.map((li) => li.getAttribute('data-action')));
  expect(stops).toEqual(read.body.result.data.restrictions[0].blocks);
  expect(stops.length).toBeGreaterThan(0);

  // The lift path: Security holds the reactivation for this freeze.
  await frozen.getByRole('button', { name: 'Reactivate in Security' }).click();
  await expect(page).toHaveURL(/\/uc\/safe$/);
  const card = page.getByTestId('security__card').filter({ has: page.getByRole('heading', { name: 'You froze this account' }) });
  await expect(card.getByRole('button', { name: 'Reactivate my account' })).toBeVisible();
});

test(`${J} #4 Asking to reactivate before the wait is over is refused with the seconds left; after it, step-up lifts the freeze`, async ({
  page,
}) => {
  // The stack's waiting time is the TEST owner value IDENTITY_SELF_FREEZE_LIFT_WAIT_SECONDS=20; a blank one refuses
  // (svc-identity self-freeze-lift tests). The lift needs a second factor, so the person adds an authenticator app.
  test.setTimeout(180_000);
  const who = person('jr');
  await signUpInBrowser(page, who);

  // The person freezes their own account from Security; every session ends.
  const frozenAt = await freezeOwn(page, who);

  // They sign in again and Account status names their own freeze.
  await signInFrozen(page, who);
  await page.goto('/uc/account');
  const status = page.getByTestId('account-status');
  await expect(status.getByTestId('account-status__state')).toHaveAttribute('data-state', 'frozen_self');
  await expect(status.getByTestId('account-status__restrictions').locator('li[data-kind="self_freeze"]')).toHaveCount(1);

  // Too soon: the service refuses with the whole seconds left, and no confirmation is asked for.
  await page.goto('/uc/safe');
  const frozen = page.getByTestId('security__card').filter({ has: page.getByRole('heading', { name: 'You froze this account' }) });
  await frozen.getByRole('button', { name: 'Reactivate my account' }).click();
  const refusal = frozen.getByTestId('freeze__lift-refusal');
  await expect(refusal).toHaveText(/^Too soon\. You can reactivate in \d+ seconds?\.$/);
  const left = Number((await refusal.textContent()).match(/in (\d+) second/)[1]);
  const elapsed = Math.ceil((Date.now() - frozenAt) / 1000);
  expect(left).toBeGreaterThanOrEqual(1);
  expect(left).toBeLessThanOrEqual(20);
  expect(left + elapsed).toBeGreaterThanOrEqual(20);
  await expect(frozen.getByTestId('step-up-confirm')).toHaveCount(0);

  // The person adds an authenticator app (a freeze stops only new API keys), then waits out the rest.
  const { totp } = await totpLib();
  const { secret, step } = await addAuthenticator(page, totp);
  const due = frozenAt + 21_000;
  if (Date.now() < due) await page.waitForTimeout(due - Date.now());

  // After the wait: the same button asks for a fresh code, and the code lifts the freeze.
  await page.goto('/uc/safe');
  await frozen.getByRole('button', { name: 'Reactivate my account' }).click();
  const confirm = frozen.getByTestId('step-up-confirm');
  await expect(confirm).toBeVisible();
  const next = await nextCode(totp, secret, step);
  await confirm.getByLabel('Authenticator code').fill(next.code);
  await confirm.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByText('Your account is active again.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Freeze your account' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'You froze this account' })).toHaveCount(0);

  // Account status agrees: nothing is restricted any more.
  await page.goto('/uc/account');
  await expect(status.getByTestId('account-status__state')).toHaveAttribute('data-state', 'active');
  await expect(status.getByTestId('account-status__restrictions')).toHaveCount(0);
});
