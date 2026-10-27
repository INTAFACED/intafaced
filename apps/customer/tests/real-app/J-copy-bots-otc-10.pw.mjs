import { test, expect } from '@playwright/test';
import { ADMIN, founderSignIn } from './admin.mjs';
import { signOutBrowser } from './stack.mjs';
import { fundedTrader, signIn } from './desk.mjs';

// J-copy-bots-otc-10, in the running app (docs/roadmap/journeys.json): vet lead applications and pooled masters in the
// founder console. One test per step, titled "J-copy-bots-otc-10 #<n>". Founders A and B are the stack's LOCAL TEST founder
// pair (admin.mjs); an approval needs both. The applicants are TEST accounts that apply through the customer app.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - The console has no copy-trading desk at /trade-ops/copy: no applications queue, two-founder approval, rejection,
//   suspension, pooled masters, whitelists, takeovers or levels (CB-ops-01, CB-copy-12, CB-copy-pro-share-03, -06, -09, -11).
// - The customer app has no lead application at /copy/lead/apply, so the queue has no applicant (CB-copy-12).
const J = 'J-copy-bots-otc-10';
const UNBUILT = { timeout: 5_000 };

test.describe.configure({ mode: 'default' });

const queue = (page) => page.getByRole('table', { name: 'Lead applications' });

/** A TEST trader with a funded account applies to lead, through the customer app, so the queue has a row to vet. */
async function apply(page) {
  const who = await fundedTrader(page, 'ld', '100');
  await signIn(page, who);
  await page.goto('/copy/lead/apply');
  await page.getByRole('button', { name: 'Apply to lead' }).click(UNBUILT);
  await expect(page.getByRole('status')).toContainText('Application sent');
  await signOutBrowser(page.context());
  return who;
}

test(`${J} starts: a TEST trader applies to lead in the customer app`, async ({ page }) => {
  test.setTimeout(180_000);
  await apply(page);
});

async function openDesk(page, founder = 'a') {
  await founderSignIn(page, founder);
  await page.goto(`${ADMIN}/trade-ops/copy`);
  await expect(page.getByRole('heading', { name: 'Copy trading', level: 1 })).toBeVisible(UNBUILT);
}

test(`${J} #1 opens the applications queue: oldest first, and with none the empty state`, async ({ page }) => {
  await openDesk(page);
  await expect(queue(page).or(page.getByText('No applications waiting'))).toBeVisible();
  const times = await queue(page)
    .locator('time')
    .evaluateAll((items) => items.map((t) => t.getAttribute('datetime')));
  expect(times).toEqual([...times].sort());
});

test(`${J} #2 approves an application whose criteria are blank: refused naming the criteria`, async ({ page }) => {
  await openDesk(page);
  await queue(page).locator('tbody tr').first().getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByRole('alert')).toContainText('The lead criteria are not set');
});

test(`${J} #3 approves with the criteria set, as one founder: pending until the second confirms; the listing exists only after both`, async ({
  page,
  browser,
}) => {
  await openDesk(page);
  // The criteria are a founder's setting on this desk; a TEST value, set before approving.
  const criteria = page.getByRole('form', { name: 'Lead criteria' });
  await criteria.getByRole('textbox', { name: 'Minimum track record, days' }).fill('30');
  await criteria.getByRole('button', { name: 'Save criteria' }).click();
  await expect(page.getByRole('status')).toContainText('Criteria saved');
  const row = queue(page).locator('tbody tr').first();
  await row.getByRole('button', { name: 'Approve' }).click();
  await expect(row).toContainText('Waiting for a second founder');
  const second = await (await browser.newContext()).newPage();
  await openDesk(second, 'b');
  await queue(second).locator('tbody tr').first().getByRole('button', { name: 'Confirm approval' }).click();
  await expect(second.getByRole('status')).toContainText('Approved and listed');
  await second.context().close();
});

test(`${J} #4 rejects with a reason: the applicant sees it and may apply again after the owner's wait`, async ({ page }) => {
  await openDesk(page);
  const row = queue(page).locator('tbody tr').first();
  await row.getByRole('button', { name: 'Reject' }).click();
  await page.getByRole('dialog').getByRole('textbox', { name: 'Reason' }).fill('TEST: track record too short');
  await page.getByRole('dialog').getByRole('button', { name: 'Reject' }).click();
  await expect(page.getByRole('status')).toContainText('Rejected');
});

test(`${J} #5 suspends a lead: the state changes once, with an audit row showing the reason`, async ({ page }) => {
  await openDesk(page);
  await page.getByRole('tab', { name: 'Leads' }).click();
  const lead = page.getByRole('table', { name: 'Leads' }).locator('tbody tr').first();
  await lead.getByRole('button', { name: 'Suspend' }).click();
  await page.getByRole('dialog').getByRole('textbox', { name: 'Reason' }).fill('TEST suspension');
  await page.getByRole('dialog').getByRole('button', { name: 'Suspend' }).click();
  await expect(lead).toContainText('Suspended');
  await page.getByRole('tab', { name: 'Audit' }).click();
  await expect(page.getByRole('table', { name: 'Audit' }).getByRole('row', { name: /TEST suspension/ })).toHaveCount(1);
});

test(`${J} #6 opens pooled masters and the pool whitelist: master applications, and whitelists with the batch limit`, async ({ page }) => {
  await openDesk(page);
  await page.getByRole('tab', { name: 'Pooled masters' }).click();
  await expect(page.getByRole('table', { name: 'Master applications' })).toBeVisible();
  await page.getByRole('tab', { name: 'Whitelists' }).click();
  await expect(page.getByRole('tabpanel', { name: 'Whitelists' })).toContainText(/Batch limit/);
});

test(`${J} #7 opens the takeover and level views: takeovers per pool and day; levels with "Maximum ratio: not set by the platform"`, async ({
  page,
}) => {
  await openDesk(page);
  await page.getByRole('tab', { name: 'Takeovers' }).click();
  await expect(page.getByRole('table', { name: 'Takeovers' })).toBeVisible();
  await page.getByRole('tab', { name: 'Levels' }).click();
  await expect(page.getByRole('tabpanel', { name: 'Levels' })).toContainText('Maximum ratio: not set by the platform');
});
