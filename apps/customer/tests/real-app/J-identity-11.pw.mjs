import { randomBytes } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { signUpInBrowser } from './stack.mjs';

// J-identity-11, in the running app (docs/roadmap/journeys.json): I freeze my own account and later reactivate it.
// One test per step this build serves, titled "J-identity-11 #<n>". Every person here is a TEST person on the local
// stack, signed up through the browser (J-identity-01) with a fresh TEST password kept only in memory for the run.
const J = 'J-identity-11';

test.describe.configure({ mode: 'default' });

function person(prefix = 'jf') {
  const handle = `${prefix}${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
  return { handle, email: `${handle}@local-test.invalid`, password: `TEST-${randomBytes(9).toString('base64url')}-9a` };
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
  await expect(status.getByTestId('account-status__cannot').locator('li')).toContainText(['Change your password']);
  await expect(status.getByTestId('account-status__can').locator('li')).toHaveText(['Sign in', 'Trade', 'Create API keys']);
});
