// World: stack
import { test, expect } from './journey.mjs';
import { forgetSession } from './identity-factors.mjs';
import { businessReadyPerson, openBusiness, refusedPayCalls, signInWithCode, verifiedBusiness } from './merchant.mjs';

// J-merchant-01 step 6 in the running app: notification preferences with their change history, and Support from the
// portal. A preference change is a write, which needs a verified business, so the founder pair approves this one. A
// Viewer team member of that business holds notifications.read but not notifications.manage (svc-pay
// merchant-ops/roles.ts), so every preference is greyed for them with the reason.
const J = 'J-merchant-01';

test(`${J} #6 the owner changes a notification preference, sees who changed it and when, and reaches Support from the portal`, async ({
  page,
}) => {
  test.setTimeout(480_000);
  const viewer = await businessReadyPerson(page, 'mview', '/pay/merchant');
  await forgetSession(page);
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
  const savedFrom = Date.now();
  // The history the page reads after the save: the service's own record of the change, with its time.
  const historyRead = page.waitForResponse(
    async (r) =>
      r.url().includes('merchantOps.notifications.preferences.history') &&
      r.request().method() === 'GET' &&
      r.status() === 200 &&
      ((await r.json().catch(() => null))?.result?.data?.items?.length ?? 0) > 0,
  );
  await row.getByRole('button', { name: 'Save' }).click();
  await expect(row.getByRole('status')).toHaveText('Saved');
  const savedTo = Date.now();
  await expect(row).toContainText('Last saved by You');
  await expect(history).toContainText('Export ready turned off');
  await expect(history).toContainText('By You');
  const historyBody = await (await historyRead).json();
  const changes = historyBody.result.data.items;
  expect(changes, 'one change recorded by the service').toHaveLength(1);
  const changedAt = changes[0].createdAt;
  // "and when": the entry shows the service's time of the change, which falls inside the save (a minute either side,
  // for the clocks of the runner and the database), written out with its year and its hour and minute.
  expect(Date.parse(changedAt)).toBeGreaterThanOrEqual(savedFrom - 60_000);
  expect(Date.parse(changedAt)).toBeLessThanOrEqual(savedTo + 60_000);
  const entry = history.getByRole('listitem').filter({ hasText: 'Export ready turned off' });
  await expect(entry.locator('time')).toHaveAttribute('datetime', changedAt);
  await expect(entry.locator('time')).toHaveText(new RegExp(`${new Date(changedAt).getUTCFullYear()}.*\\d{1,2}:\\d{2}`));

  // The change is the service's record, not the page's memory.
  await page.reload();
  await expect(historyOf(page)).toContainText('Export ready turned off');
  await expect(historyOf(page).getByRole('listitem').filter({ hasText: 'Export ready turned off' }).locator('time')).toHaveAttribute(
    'datetime',
    changedAt,
  );
  await expect(page.locator('li[data-testid="pp-pref"]').filter({ hasText: 'Export ready' }).getByRole('checkbox')).not.toBeChecked();
  await expect(page.getByText(/History is not connected|is not recorded/)).toHaveCount(0);

  await page.getByRole('link', { name: 'Help and support' }).click();
  await expect(page).toHaveURL(/\/support$/);
  await expect(page.getByLabel('Search help')).toBeVisible();
  expect(refused).toEqual([]);

  // A person without the permission: the owner adds a Viewer by account ID (email invitations are off on this stack).
  await page.goto('/pay/team');
  expect(viewer.userId).toMatch(/^[0-9a-f-]{36}$/);
  await page.getByRole('button', { name: 'Invite by account ID instead' }).click();
  await page.getByLabel('Account ID *').fill(viewer.userId);
  await page.getByRole('combobox', { name: /^Role \*/ }).selectOption({ label: 'Viewer' });
  await page.getByRole('button', { name: 'Send invitation' }).click();
  await page.getByRole('dialog').locator('[data-testid="form-stack"] > button').last().click();
  await expect(
    page
      .getByRole('row')
      .filter({ hasText: 'Viewer' })
      .filter({ hasText: /Invited/ }),
  ).toHaveCount(1);
  await forgetSession(page);
  await signInWithCode(page, viewer, '/pay/team');
  const accept = page.locator('li').filter({ hasText: 'Viewer' }).getByRole('button', { name: 'Accept' }).first();
  await expect(async () => {
    await page.reload();
    await expect(accept).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 30_000 });
  await accept.click();
  await page.getByRole('dialog').locator('[data-testid="form-stack"] > button').last().click();
  await expect(accept).toHaveCount(0);

  // The Viewer reads the same preferences, each greyed: its switch and Save cannot be used, and the row says why, naming
  // the permission they lack.
  await page.goto('/pay/settings/notifications');
  const viewerRows = page.locator('li[data-testid="pp-pref"]');
  await expect(viewerRows.first()).toBeVisible();
  const count = await viewerRows.count();
  expect(count, 'the preferences the Viewer reads').toBeGreaterThan(0);
  for (let i = 0; i < count; i++) {
    const pref = viewerRows.nth(i);
    await expect(pref.getByRole('checkbox')).toBeDisabled();
    await expect(pref.getByRole('button', { name: 'Save' })).toBeDisabled();
    await expect(pref).toContainText(/notifications\.manage|manage notification/i);
  }
  // The owner's saved change still shows, and not as the Viewer's own.
  await expect(viewerRows.filter({ hasText: 'Export ready' }).getByRole('checkbox')).not.toBeChecked();
  await expect(viewerRows.filter({ hasText: 'Export ready' })).not.toContainText('Last saved by You');
});
