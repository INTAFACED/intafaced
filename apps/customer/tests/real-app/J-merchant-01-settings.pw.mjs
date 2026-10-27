import { test, expect } from '@playwright/test';
import { forgetSession } from './identity-factors.mjs';
import { businessReadyPerson, openBusiness, refusedPayCalls, signInWithCode, verifiedBusiness } from './merchant.mjs';

// J-merchant-01 step 6 in the running app: notification preferences with their change history, and Support from the
// portal. A preference change is a write, which needs a verified business, so the founder pair approves this one.
const J = 'J-merchant-01';

test(`${J} #6 the owner changes a notification preference, sees who changed it and when, and reaches Support from the portal`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const owner = await businessReadyPerson(page, 'mset', '/pay/onboarding');
  const merchantId = await openBusiness(page, owner, 'TEST Alerts Ltd');
  await verifiedBusiness(page, owner, merchantId);
  await forgetSession(page);
  await signInWithCode(page, owner, '/pay/settings/notifications');
  const refused = refusedPayCalls(page);

  const historyOf = (p) => p.locator('section').filter({ has: p.getByRole('heading', { name: 'Change history', level: 2 }) });
  const history = historyOf(page);
  await expect(history).toContainText('No changes yet');
  const row = page.locator('li[data-testid="pp-pref"]').filter({ hasText: 'Export ready' });
  await row.getByRole('checkbox').uncheck();
  await row.getByRole('button', { name: 'Save' }).click();
  await expect(row.getByRole('status')).toHaveText('Saved');
  await expect(row).toContainText('Last saved by You');
  await expect(history).toContainText('Export ready turned off');
  await expect(history).toContainText('By You');

  // The change is the service's record, not the page's memory.
  await page.reload();
  await expect(historyOf(page)).toContainText('Export ready turned off');
  await expect(page.locator('li[data-testid="pp-pref"]').filter({ hasText: 'Export ready' }).getByRole('checkbox')).not.toBeChecked();
  await expect(page.getByText(/History is not connected|is not recorded/)).toHaveCount(0);

  await page.getByRole('link', { name: 'Help and support' }).click();
  await expect(page).toHaveURL(/\/support$/);
  await expect(page.getByLabel('Search help')).toBeVisible();
  expect(refused).toEqual([]);
});
