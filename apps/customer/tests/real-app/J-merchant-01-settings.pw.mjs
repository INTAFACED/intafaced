// World: stack
import { test, expect } from './journey.mjs';
import { forgetSession } from './identity-factors.mjs';
import { responseAfterNavigation } from './navigation.mjs';
import { businessReadyPerson, openBusiness, refusedPayCalls, signInWithCode, verifiedBusiness } from './merchant.mjs';

// J-merchant-01 step 6 in the running app: notification preferences saved per person with their change history, and
// Support from the portal. The journey's own state: the owner's business has verification not done, and the owner saves
// their own preference in it (svc-pay ownPreferenceWrite: a personal choice takes no KYB gate). Inviting a teammate is a
// team write that needs a verified business, so only then does the founder pair approve it, for the second half: a
// Viewer team member holds notifications.read but not notifications.manage (svc-pay merchant-ops/roles.ts), so every
// preference is greyed for them with the reason, and the owner's choice is not theirs.
const J = 'J-merchant-01';

test(`${J} #6 the owner changes a notification preference, saved for them alone, sees who changed it and when, and reaches Support from the portal; a Viewer reads their own preferences greyed with the reason`, async ({
  page,
}) => {
  test.setTimeout(480_000);
  const viewer = await businessReadyPerson(page, 'mview', '/pay/merchant');
  await forgetSession(page);
  const owner = await businessReadyPerson(page, 'mset', '/pay/onboarding');
  const merchantId = await openBusiness(page, owner, 'TEST Alerts Ltd');
  await forgetSession(page);
  // The Starts state: the owner of a business whose verification is not done.
  await signInWithCode(page, owner, '/pay/merchant');
  const { res: access } = await responseAfterNavigation(page, (r) => r.url().includes('merchant.myAccess') && r.status() === 200);
  const memberships = (Array.isArray(access.body) ? access.body[0] : access.body).result.data.memberships;
  expect(memberships).toEqual([expect.objectContaining({ role: 'owner', kybStatus: 'none', verified: false })]);
  await expect(page.getByText('Not verified').first()).toBeVisible();
  await page.goto('/pay/settings/notifications');
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
  // Support itself: its help search and the way to ask a person, not just its address.
  await expect(page.getByLabel('Search help')).toBeVisible();
  const desk = page.getByRole('tablist', { name: 'Support sections' });
  for (const name of ['Help articles', 'Your requests', 'New request']) await expect(desk.getByRole('tab', { name })).toBeVisible();
  expect(refused).toEqual([]);

  // The team half needs a verified business: the founder pair approves this one now, and the owner's own choice, saved
  // before it, stays as it was.
  await verifiedBusiness(page, owner, merchantId);
  await forgetSession(page);
  await signInWithCode(page, owner, '/pay/settings/notifications');
  await expect(page.locator('li[data-testid="pp-pref"]').filter({ hasText: 'Export ready' }).getByRole('checkbox')).not.toBeChecked();

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
  const { res: viewerPrefs } = await responseAfterNavigation(
    page,
    (r) => r.url().includes('merchantOps.notifications.preferences.list') && r.request().method() === 'GET',
    { navigate: () => page.goto('/pay/settings/notifications') },
  );
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
  // Saved per person: the owner turned Export ready off for themself, not for the Viewer. The Viewer reads their own
  // choices from the service, every kind on by default, none saved by anyone, and an empty history of their own.
  expect(viewerPrefs.status, 'the Viewer reads their own preferences').toBe(200);
  const viewerKinds = viewerPrefs.body.result.data;
  expect(viewerKinds.find((p) => p.kind === 'export_ready')).toMatchObject({ inApp: true, updatedBy: null });
  expect(viewerKinds.every((p) => p.inApp === true && p.updatedBy === null)).toBe(true);
  await expect(viewerRows.filter({ hasText: 'Export ready' }).getByRole('checkbox')).toBeChecked();
  await expect(viewerRows.filter({ hasText: 'Export ready' })).not.toContainText('Last saved');
  await expect(historyOf(page)).toContainText('No changes yet');
  await expect(historyOf(page)).not.toContainText('Export ready turned off');

  // And the owner's own choice is still theirs after the Viewer's visit.
  await forgetSession(page);
  await signInWithCode(page, owner, '/pay/settings/notifications');
  const ownerRow = page.locator('li[data-testid="pp-pref"]').filter({ hasText: 'Export ready' });
  await expect(ownerRow.getByRole('checkbox')).not.toBeChecked();
  await expect(ownerRow).toContainText('Last saved by You');
  await expect(historyOf(page)).toContainText('Export ready turned off');
});
