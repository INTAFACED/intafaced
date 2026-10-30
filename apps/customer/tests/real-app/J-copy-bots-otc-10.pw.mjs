import { test, expect } from '@playwright/test';
import { ADMIN, founderSignIn } from './admin.mjs';
import { api, journeyState, signOutBrowser } from './stack.mjs';
import { fundedTrader, signIn } from './desk.mjs';
import { tableIn, bodyRows } from './tables.mjs';

// J-copy-bots-otc-10, in the running app (docs/roadmap/journeys.json): vet lead applications and pooled masters in the
// founder console. One test per step, titled "J-copy-bots-otc-10 #<n>". Founders A and B are the stack's LOCAL TEST founder
// pair (admin.mjs); an approval needs both. The applicants are TEST accounts that apply through the customer app.
// The lead criteria are owner values kept append-only, so #2 (criteria blank) holds on a fresh stack, as each CI shard is;
// a second local run on the same stack needs a fresh one. Pooled masters, whitelists, takeovers and levels are parked
// views with their honest empty or unset state: #6 waits on CB-copy-pro-share-11 and -06, #7 on -09 and -03.
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

test(`${J} #1 with no applications waiting, the empty state`, async ({ page }) => {
  // Before this run applies: on a fresh stack svc-trade's queue is empty, and the desk says so instead of an empty table.
  await openDesk(page);
  const waiting = (await readDesk(page)).queue.applications;
  expect(waiting, 'the queue is empty on a fresh stack; a second run on the same stack needs a fresh one').toEqual([]);
  await expect(page.getByText('No applications waiting.')).toBeVisible();
  await expect(page.getByRole('table', { name: 'Lead applications' })).toHaveCount(0);
});

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

/** The desk's own server route, from a console page signed in as a founder, with its CSRF token: { status, body }. */
async function deskCall(page, body) {
  return page.evaluate(async (input) => {
    const session = await (await fetch('/api/session', { cache: 'no-store' })).json();
    const res = await fetch('/api/trade-ops/copy', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-intafaced-csrf': session.csrf },
      body: JSON.stringify(input),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }, body);
}

/** svc-trade's lead desk as the console reads it: { queue: { applications, criteria }, leads, audit }. */
async function readDesk(page) {
  const { status, body } = await deskCall(page, { action: 'read' });
  expect(status, JSON.stringify(body).slice(0, 300)).toBe(200);
  return body.data;
}

/** This run's application under `name`, as svc-trade holds it now, or undefined once it is decided. */
const applicationOf = (desk, name) => desk.queue.applications.find((a) => a.displayName === name);

/** The desk's answer to the action it posts while `act` runs: { status, body }. */
async function answerTo(page, action, act) {
  const [res] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/trade-ops/copy') && r.request().postDataJSON()?.action === action),
    act(),
  ]);
  return { status: res.status(), body: await res.json() };
}

const codeOf = (body) => body?.error?.data?.cause?.code;

async function openDesk(page, founder = 'a') {
  await founderSignIn(page, founder);
  await page.goto(`${ADMIN}/trade-ops/copy`);
  await expect(page.getByRole('heading', { name: 'Copy trading', level: 1 })).toBeVisible(UNBUILT);
}

test(`${J} #1 opens the applications queue: oldest first`, async ({ page }) => {
  await openDesk(page);
  // This run applied A, then B: both wait in the queue, A first, and the whole queue is oldest first.
  const desk = await readDesk(page);
  const a = applicationOf(desk, state('approve'));
  const b = applicationOf(desk, state('reject'));
  expect([a?.status, b?.status]).toEqual(['pending', 'pending']);
  expect(Date.parse(a.appliedAt)).toBeLessThan(Date.parse(b.appliedAt));
  const names = await bodyRows(queue(page)).evaluateAll((rows) => rows.map((r) => r.textContent ?? ''));
  const at = (name) => names.findIndex((text) => text.includes(name));
  expect(at(state('approve')), "this run's first applicant is in the queue").toBeGreaterThanOrEqual(0);
  expect(at(state('approve'))).toBeLessThan(at(state('reject')));
  const times = await queue(page)
    .getByTestId('applied-at')
    .evaluateAll((items) => items.map((t) => t.getAttribute('datetime')));
  expect(times).toHaveLength(names.length);
  expect(times).toEqual([...times].sort());
  expect(times).toEqual(desk.queue.applications.map((x) => x.appliedAt));
});

test(`${J} #2 approves an application whose criteria are blank: refused naming the criteria`, async ({ page }) => {
  await openDesk(page);
  expect((await readDesk(page)).queue.criteria, 'the lead criteria are blank on this stack').toBeNull();
  const answer = await answerTo(page, 'approve', () =>
    rowOf(queue(page), state('approve')).getByRole('button', { name: 'Approve' }).click(),
  );
  expect([answer.status, answer.body.code]).toEqual([412, 'trade.copy_lead_criteria_unset']);
  await expect(page.getByRole('alert').filter({ hasText: 'The lead criteria are not set' })).toBeVisible();
  // Nothing was filed: the application still waits as it was, and no lead is listed under its name.
  const desk = await readDesk(page);
  expect(applicationOf(desk, state('approve'))).toMatchObject({ status: 'pending', approvalId: null });
  expect(desk.leads.filter((l) => l.displayName === state('approve'))).toEqual([]);
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
  // Founder A cannot confirm their own approval: no control is offered, and the desk's route refuses it by code.
  await expect(row.getByRole('button', { name: 'Confirm approval' })).toHaveCount(0);
  const waiting = applicationOf(await readDesk(page), state('approve'));
  expect(waiting.status).toBe('awaiting_second');
  const own = await deskCall(page, { action: 'confirm', applicationId: waiting.id });
  expect([own.status, own.body.code]).toEqual([409, 'action_approval.same_person']);
  const afterOwn = await readDesk(page);
  expect(applicationOf(afterOwn, state('approve'))?.status).toBe('awaiting_second');
  expect(afterOwn.leads.filter((l) => l.displayName === state('approve'))).toEqual([]);
  const second = await (await browser.newContext()).newPage();
  await openDesk(second, 'b');
  await rowOf(queue(second), state('approve')).getByRole('button', { name: 'Confirm approval' }).click();
  await expect(second.getByRole('status').filter({ hasText: 'Approved and listed' })).toBeVisible();
  await second.getByRole('tab', { name: 'Leads' }).click();
  await expect(rowOf(tableIn(second, 'Leads'), state('approve'))).toContainText('Listed');
  const listed = await readDesk(second);
  expect(applicationOf(listed, state('approve'))).toBeUndefined();
  expect(listed.leads.filter((l) => l.displayName === state('approve')).map((l) => l.state)).toEqual(['listed']);
  await second.context().close();
});

test(`${J} #4 rejects with a reason: the applicant sees it, and applying again is refused by the wait's code`, async ({ page }) => {
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
  // svc-trade refuses a new application by the wait's code, and the applicant's application is still the rejected one.
  const applicant = await api(state('rejectWho'));
  const again = await applicant.post('/api/trade/trpc/copy.applyToLead', { displayName: `${state('reject')} again` });
  expect(codeOf(again.body), JSON.stringify(again.body).slice(0, 300)).toBe('trade.copy_lead_reapply_wait_unset');
});

test(`${J} #4 may apply again after the owner's wait`, async ({ page }) => {
  // The wait is the owner's and unset, so a rejected applicant is never offered the form again: this clause cannot pass yet.
  await signIn(page, state('rejectWho'));
  await page.goto('/copy/lead/apply');
  await expect(page.getByText('waits on a waiting period the platform has not set')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Apply to lead' }),
    "UNSET: the owner's wait before a rejected applicant may apply again is not set (trade.copy_lead_reapply_wait_unset)",
  ).toBeVisible(UNBUILT);
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
  // A second suspend is refused by its code and changes nothing: the lead stays suspended, with one audit row.
  const ref = (await readDesk(page)).leads.find((l) => l.displayName === state('approve')).leaderRef;
  const again = await deskCall(page, { action: 'suspend', leaderRef: ref, reason: `${reason} again` });
  expect([again.status, again.body.code]).toEqual([409, 'trade_ops.copy_lead_suspended']);
  const desk = await readDesk(page);
  expect(desk.leads.filter((l) => l.leaderRef === ref).map((l) => l.state)).toEqual(['suspended']);
  expect(desk.audit.filter((r) => r.reason?.startsWith(reason)).map((r) => r.reason)).toEqual([reason]);
  await page.getByRole('tab', { name: 'Audit' }).click();
  await expect(tableIn(page, 'Audit').getByRole('row', { name: new RegExp(reason) })).toHaveCount(1);
});

test(`${J} #6 opens pooled masters and the pool whitelist: master applications, and whitelists with the batch limit`, async ({ page }) => {
  await openDesk(page);
  // The tables must come from a service: pools are not built, so nothing reads master applications or whitelists.
  expect(
    (await readDesk(page)).pooledMasters,
    'UNBUILT: CB-copy-pro-share-11 (master center) and CB-copy-pro-share-06 (whitelists): pooled master applications and whitelists are read from no service',
  ).toBeDefined();
  await page.getByRole('tab', { name: 'Pooled masters' }).click();
  await expect(tableIn(page, 'Master applications')).toBeVisible();
  await page.getByRole('tab', { name: 'Whitelists' }).click();
  await expect(page.getByRole('tabpanel', { name: 'Whitelists' })).toContainText(/Batch limit/);
});

test(`${J} #7 opens the takeover and level views: takeovers per pool and day; levels with "Maximum ratio: not set by the platform"`, async ({
  page,
}) => {
  await openDesk(page);
  expect(
    (await readDesk(page)).takeovers,
    'UNBUILT: CB-copy-pro-share-09 (takeovers) and CB-copy-pro-share-03 (levels): takeovers per pool and day and the level ratios are read from no service',
  ).toBeDefined();
  await page.getByRole('tab', { name: 'Takeovers' }).click();
  await expect(tableIn(page, 'Takeovers')).toBeVisible();
  await page.getByRole('tab', { name: 'Levels' }).click();
  await expect(page.getByRole('tabpanel', { name: 'Levels' })).toContainText('Maximum ratio: not set by the platform');
});
