import { test, expect } from '@playwright/test';
import { ADMIN, founderSignIn } from './admin.mjs';
import { journeyState, signOutBrowser } from './stack.mjs';
import { fundedTrader, signIn } from './desk.mjs';

// J-copy-bots-otc-10, in the running app (docs/roadmap/journeys.json): two founders vet lead applications and pooled
// masters on the founder console's /trade-ops/copy. One test per step, titled "J-copy-bots-otc-10 #<n>", run in order.
// The applicants are fresh verified TEST customers who apply to lead from the customer app's Copy room; the founders
// sign in with the stack's LOCAL TEST founder pair. The lead criteria are the stack's TEST copy-lead terms.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - every step: the console has no /trade-ops/copy room, and the customer Copy room has no "Apply to lead" door, so no
//   application exists to vet. Leaders are listed today only through copy.ops.upsertListing.
const J = 'J-copy-bots-otc-10';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const UNBUILT = { timeout: 5_000 };

test.describe.configure({ mode: 'default' });
// An action on a part that never appears fails in 15 s, not at the test's time limit.
test.use({ actionTimeout: 15_000 });

const founders = { a: null, b: null };
async function founder(browser, key) {
  if (!founders[key]) {
    founders[key] = await (await browser.newContext()).newPage();
    await founderSignIn(founders[key], key);
  }
  return founders[key];
}

function state(key) {
  const value = run.read()[key];
  if (!value) throw new Error(`${J}: an earlier step made no ${key}, so this step has nothing to act on`);
  return value;
}

const queue = (page) => page.getByRole('table', { name: 'Lead applications' });
const rowOf = (page, handle) => queue(page).getByRole('row', { name: new RegExp(handle) });

async function openCopyOps(page, tab = 'Applications') {
  await page.goto(`${ADMIN}/trade-ops/copy`);
  await expect(page.getByRole('heading', { name: 'Copy trading', level: 1 })).toBeVisible(UNBUILT);
  await page.getByRole('tab', { name: tab, exact: true }).click();
}

/** A verified, funded customer applies to lead from the Copy room. */
async function applyToLead(page, prefix) {
  const who = await fundedTrader(page, prefix, '2000');
  await signIn(page, who);
  await page.goto('/trade/copy');
  await page.getByRole('button', { name: 'Become a lead trader' }).click(UNBUILT);
  const sheet = page.getByRole('dialog', { name: 'Apply to lead' });
  await sheet.getByLabel('Display name').fill(`TEST lead ${who.handle}`);
  await sheet.getByRole('button', { name: 'Send application' }).click();
  await expect(page.getByText('Application sent')).toBeVisible();
  await signOutBrowser(page.context());
  return who;
}

test(`${J} #1 opens the applications queue: oldest first, and the empty state when there are none`, async ({ browser }) => {
  run.reset({});
  const a = await founder(browser, 'a');
  await openCopyOps(a);
  const table = queue(a);
  await expect(table.or(a.getByText('No applications are waiting.'))).toBeVisible();
  if (await table.isVisible()) {
    const submitted = await table.getByRole('cell', { name: /^\d{4}-\d{2}-\d{2}/ }).allInnerTexts();
    expect(submitted).toEqual([...submitted].sort());
  }
});

test(`${J} #2 approves an application whose criteria are blank: refused naming the criteria`, async ({ page, browser }) => {
  test.setTimeout(240_000);
  const first = await applyToLead(page, 'jla');
  run.write({ first });
  const a = await founder(browser, 'a');
  await openCopyOps(a);
  // The stack's TEST terms leave the futures criteria blank, so a futures application has none to approve against.
  await rowOf(a, first.handle).getByRole('button', { name: 'Approve' }).click();
  await a.getByRole('dialog', { name: 'Approve this lead' }).getByLabel('Market').selectOption('Futures');
  await a.getByRole('dialog', { name: 'Approve this lead' }).getByRole('button', { name: 'Approve' }).click();
  await expect(a.getByText('The lead criteria for futures are not set, so no lead can be approved.')).toBeVisible();
  await expect(rowOf(a, first.handle)).toContainText('Waiting');
});

test(`${J} #3 approves with the criteria set as one founder: pending until the second confirms; listed only after both`, async ({
  page,
  browser,
}) => {
  const first = state('first');
  const a = await founder(browser, 'a');
  await openCopyOps(a);
  await rowOf(a, first.handle).getByRole('button', { name: 'Approve' }).click();
  const sheet = a.getByRole('dialog', { name: 'Approve this lead' });
  await sheet.getByLabel('Market').selectOption('Spot');
  await sheet.getByRole('button', { name: 'Approve' }).click();
  await expect(rowOf(a, first.handle)).toContainText('Waiting for a second founder');

  // Not listed yet: the customer directory doesn't show the lead.
  await page.goto('/trade/copy');
  await page.getByRole('searchbox', { name: /Search/ }).fill(first.handle);
  await expect(page.getByText(`TEST lead ${first.handle}`)).toHaveCount(0);

  const b = await founder(browser, 'b');
  await openCopyOps(b);
  await rowOf(b, first.handle).getByRole('button', { name: 'Confirm approval' }).click();
  await expect(rowOf(b, first.handle)).toContainText('Approved');
  await page.reload();
  await page.getByRole('searchbox', { name: /Search/ }).fill(first.handle);
  await expect(page.getByText(`TEST lead ${first.handle}`)).toBeVisible();
});

test(`${J} #4 rejects with a reason: the applicant sees it and may apply again after the owner's wait`, async ({ page, browser }) => {
  test.setTimeout(240_000);
  const second = await applyToLead(page, 'jlr');
  run.write({ second });
  const a = await founder(browser, 'a');
  await openCopyOps(a);
  await rowOf(a, second.handle).getByRole('button', { name: 'Reject' }).click();
  const sheet = a.getByRole('dialog', { name: 'Reject this application' });
  await sheet.getByLabel('Reason the applicant sees').fill('TEST: trading history is shorter than the criteria ask.');
  await sheet.getByRole('button', { name: 'Reject' }).click();
  await expect(rowOf(a, second.handle)).toContainText('Rejected');

  await signIn(page, second);
  await page.goto('/trade/copy');
  await expect(page.getByText('TEST: trading history is shorter than the criteria ask.')).toBeVisible();
  // The wait is the owner's (a TEST value on the stack); until it passes the door says when.
  await expect(page.getByText(/You can apply again (on|after) /)).toBeVisible();
});

test(`${J} #5 suspends a lead: the state changes once, with an audit row showing the reason`, async ({ browser }) => {
  const first = state('first');
  const a = await founder(browser, 'a');
  await openCopyOps(a, 'Leads');
  const row = a.getByRole('table', { name: 'Leads' }).getByRole('row', { name: new RegExp(first.handle) });
  await row.getByRole('button', { name: 'Suspend' }).click(UNBUILT);
  const sheet = a.getByRole('dialog', { name: 'Suspend this lead' });
  await sheet.getByLabel('Reason').fill('LOCAL TEST J-copy-bots-otc-10 suspend');
  await sheet.getByRole('button', { name: 'Suspend' }).click();
  await expect(row).toContainText('Suspended');
  // A second press finds it already suspended and writes nothing.
  await expect(row.getByRole('button', { name: 'Suspend' })).toHaveCount(0);
  await a.goto(`${ADMIN}/trade-ops/audit`);
  const audit = a.getByRole('table', { name: 'Audit' });
  await expect(audit.getByRole('row', { name: /LOCAL TEST J-copy-bots-otc-10 suspend/ })).toHaveCount(1);
});

test(`${J} #6 opens pooled masters and the pool whitelist: master applications, and whitelists with the batch limit`, async ({
  browser,
}) => {
  const a = await founder(browser, 'a');
  await openCopyOps(a, 'Pooled masters');
  await expect(a.getByRole('table', { name: 'Master applications' }).or(a.getByText('No master applications.'))).toBeVisible();
  await a.getByRole('tab', { name: 'Pool whitelists', exact: true }).click();
  await expect(a.getByText(/Batch limit: (\d+|Not set by the platform)/)).toBeVisible();
});

test(`${J} #7 opens the takeover and level views: takeover rows per pool and day; levels with "Maximum ratio: not set by the platform"`, async ({
  browser,
}) => {
  const a = await founder(browser, 'a');
  await openCopyOps(a, 'Takeovers');
  const takeovers = a.getByRole('table', { name: 'Takeovers' });
  await expect(takeovers.or(a.getByText('No takeovers.'))).toBeVisible();
  if (await takeovers.isVisible()) {
    for (const header of ['Pool', 'Day']) await expect(takeovers.getByRole('columnheader', { name: header })).toBeVisible();
  }
  await a.getByRole('tab', { name: 'Lead levels', exact: true }).click();
  await expect(a.getByText('Maximum ratio: not set by the platform').first()).toBeVisible();
});
