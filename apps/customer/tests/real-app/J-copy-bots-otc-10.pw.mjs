import { test, expect } from '@playwright/test';
import { ADMIN, founderSignIn } from './admin.mjs';
import { journeyState, signOutBrowser } from './stack.mjs';
import { fundedTrader, signIn } from './desk.mjs';
import { tableIn, bodyRows } from './tables.mjs';

// J-copy-bots-otc-10, in the running app (docs/roadmap/journeys.json): vet lead applications and pooled masters in the
// founder console. One test per step, titled "J-copy-bots-otc-10 #<n>". Founders A and B are the stack's LOCAL TEST founder
// pair (admin.mjs); an approval needs both. The applicants are TEST accounts that apply through the customer app.
// The lead criteria are owner values kept append-only, so #2 (criteria blank) holds on a fresh stack, as each CI shard is;
// a second local run on the same stack needs a fresh one. Pooled masters, whitelists, takeovers and levels are parked
// views with their honest empty or unset state (CB-copy-pro-share-03, -06, -09, -11).
const J = 'J-copy-bots-otc-10';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const UNBUILT = { timeout: 5_000 };

test.describe.configure({ mode: 'default' });

const queue = (page) => tableIn(page, 'Lead applications');

function state(key) {
  const value = run.read()[key];
  if (!value) throw new Error(`${J}: an earlier step made no ${key}, so this step has nothing to act on`);
  return value;
}

/** This run's row in a desk table, by the display name its applicant chose: rows from other runs are never acted on. */
const rowOf = (table, name) => bodyRows(table).filter({ hasText: name });

/** A TEST trader with a funded account applies to lead under `name`, through the customer app, so the queue has a row to vet. */
async function apply(page, name) {
  const who = await fundedTrader(page, 'ld', '100');
  await signIn(page, who);
  await page.goto('/copy/lead/apply');
  await page.getByRole('textbox', { name: 'Display name' }).fill(name, UNBUILT);
  await page.getByRole('button', { name: 'Apply to lead' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Application sent' })).toBeVisible();
  await signOutBrowser(page.context());
  return who;
}

test(`${J} starts: a TEST trader applies to lead in the customer app`, async ({ page }) => {
  test.setTimeout(240_000);
  // Two applicants, named for this run: #3 approves the first, #4 rejects the second.
  const tag = Date.now().toString(36);
  const approve = `TEST lead ${tag} A`;
  const reject = `TEST lead ${tag} B`;
  run.reset({ tag, approve, reject });
  await apply(page, approve);
  run.write({ rejectWho: await apply(page, reject) });
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
    .getByTestId('applied-at')
    .evaluateAll((items) => items.map((t) => t.getAttribute('datetime')));
  expect(times).toEqual([...times].sort());
});

test(`${J} #2 approves an application whose criteria are blank: refused naming the criteria`, async ({ page }) => {
  await openDesk(page);
  await rowOf(queue(page), state('approve')).getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'The lead criteria are not set' })).toBeVisible();
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
  await expect(page.getByRole('status').filter({ hasText: 'Criteria saved' })).toBeVisible();
  const row = rowOf(queue(page), state('approve'));
  await row.getByRole('button', { name: 'Approve' }).click();
  await expect(row).toContainText('Waiting for a second founder');
  await page.getByRole('tab', { name: 'Leads' }).click();
  await expect(rowOf(tableIn(page, 'Leads'), state('approve'))).toHaveCount(0);
  const second = await (await browser.newContext()).newPage();
  await openDesk(second, 'b');
  await rowOf(queue(second), state('approve')).getByRole('button', { name: 'Confirm approval' }).click();
  await expect(second.getByRole('status').filter({ hasText: 'Approved and listed' })).toBeVisible();
  await second.getByRole('tab', { name: 'Leads' }).click();
  await expect(rowOf(tableIn(second, 'Leads'), state('approve'))).toContainText('Listed');
  await second.context().close();
});

test(`${J} #4 rejects with a reason: the applicant sees it and may apply again after the owner's wait`, async ({ page }) => {
  await openDesk(page);
  const reason = `TEST: track record too short ${state('tag')}`;
  await rowOf(queue(page), state('reject')).getByRole('button', { name: 'Reject' }).click();
  await page.getByRole('dialog').getByRole('textbox', { name: 'Reason' }).fill(reason);
  await page.getByRole('dialog').getByRole('button', { name: 'Reject' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Rejected' })).toBeVisible();
  await signOutBrowser(page.context());
  // The applicant reads the reason; the wait before applying again is the owner's and unset, so no form is offered.
  await signIn(page, state('rejectWho'));
  await page.goto('/copy/lead/apply');
  await expect(page.getByText(reason)).toBeVisible();
  await expect(page.getByText('waits on a waiting period the platform has not set')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Apply to lead' })).toHaveCount(0);
});

test(`${J} #5 suspends a lead: the state changes once, with an audit row showing the reason`, async ({ page }) => {
  await openDesk(page);
  await page.getByRole('tab', { name: 'Leads' }).click();
  // This run's lead only: leads listed by other journeys are left as they are.
  const lead = rowOf(tableIn(page, 'Leads'), state('approve'));
  const reason = `TEST suspension ${state('tag')}`;
  await lead.getByRole('button', { name: 'Suspend' }).click();
  await page.getByRole('dialog').getByRole('textbox', { name: 'Reason' }).fill(reason);
  await page.getByRole('dialog').getByRole('button', { name: 'Suspend' }).click();
  await expect(lead).toContainText('Suspended');
  await expect(lead.getByRole('button', { name: 'Suspend' })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Audit' }).click();
  await expect(tableIn(page, 'Audit').getByRole('row', { name: new RegExp(reason) })).toHaveCount(1);
});

test(`${J} #6 opens pooled masters and the pool whitelist: master applications, and whitelists with the batch limit`, async ({ page }) => {
  await openDesk(page);
  await page.getByRole('tab', { name: 'Pooled masters' }).click();
  await expect(tableIn(page, 'Master applications')).toBeVisible();
  await page.getByRole('tab', { name: 'Whitelists' }).click();
  await expect(page.getByRole('tabpanel', { name: 'Whitelists' })).toContainText(/Batch limit/);
});

test(`${J} #7 opens the takeover and level views: takeovers per pool and day; levels with "Maximum ratio: not set by the platform"`, async ({
  page,
}) => {
  await openDesk(page);
  await page.getByRole('tab', { name: 'Takeovers' }).click();
  await expect(tableIn(page, 'Takeovers')).toBeVisible();
  await page.getByRole('tab', { name: 'Levels' }).click();
  await expect(page.getByRole('tabpanel', { name: 'Levels' })).toContainText('Maximum ratio: not set by the platform');
});
