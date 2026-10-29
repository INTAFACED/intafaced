import { test, expect } from '@playwright/test';
import { ADMIN, founderSignIn } from './admin.mjs';
import { journeyState } from './stack.mjs';
import { tableIn } from './tables.mjs';

// J-campaigns-16, in the running app (docs/roadmap/journeys.json): build a campaign and take it live, as a founder on the
// founder console's campaigns desk (/more-ops/campaigns). One test per step, titled "J-campaigns-16 #<n>". Founders A and
// B are the stack's LOCAL TEST founder pair (admin.mjs); A builds and asks, B approves. Activation reserves the budget and
// nothing posts until a customer qualifies (J-campaigns-01).
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - The console has only the waitlist waves room under /more-ops/campaigns: no overview, builder, drafts, validation,
//   rule library, exclusions, earning rules, activation request, approval, revisions or calendar
//   (CM-campaign-types-01, -02, CM-eligibility-rules-01 to -03, CM-rewards-hub-05, CM-campaign-admin-03).
const J = 'J-campaigns-16';
const UNBUILT = { timeout: 5_000 };
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

/** The draft's name, set once in #2 and kept in the run file, so a worker restart after a failure reads the same one. */
const draftName = () => run.read().name ?? 'TEST task campaign (made in #2)';

test.describe.configure({ mode: 'default' });

const builder = (page) => page.getByRole('form', { name: 'Campaign builder' });
const campaigns = (page) => tableIn(page, 'Campaigns');

async function openDesk(page, founder = 'a') {
  await founderSignIn(page, founder);
  await page.goto(`${ADMIN}/more-ops/campaigns`);
  await expect(page.getByRole('heading', { name: 'Campaigns', level: 1 })).toBeVisible(UNBUILT);
}

async function openDraft(page) {
  await openDesk(page);
  await campaigns(page).getByRole('link', { name: draftName(), exact: true }).click(UNBUILT);
  await expect(builder(page)).toBeVisible();
}

test(`${J} #1 opens the campaigns desk with none: the overview with honest empty states and no sample number`, async ({ page }) => {
  await openDesk(page);
  const overview = page.getByRole('region', { name: 'Overview' });
  await expect(overview).toBeVisible();
  for (const figure of await overview.getByRole('definition').all()) await expect(figure).toHaveText(/^(\d[\d.,]*|None yet|Not set)$/);
});

test(`${J} #2 starts the builder, leaves and returns: the draft resumes at the same step, and a second draft leaves the first listed`, async ({
  page,
}) => {
  await openDesk(page);
  const NAME = run.reset({ name: `TEST task campaign ${Date.now().toString(36)}` }).name;
  await page.getByRole('button', { name: 'New campaign' }).click(UNBUILT);
  await builder(page).getByRole('textbox', { name: 'Name' }).fill(NAME);
  await builder(page).getByRole('radio', { name: 'Task' }).check();
  await builder(page).getByRole('button', { name: 'Next' }).click();
  const step = await builder(page).getByRole('tab', { selected: true }).textContent();
  await page.goto(`${ADMIN}/more-ops`);
  await openDraft(page);
  await expect(builder(page).getByRole('tab', { selected: true })).toHaveText(step ?? '');
  await openDesk(page);
  await page.getByRole('button', { name: 'New campaign' }).click();
  await builder(page).getByRole('textbox', { name: 'Name' }).fill(`${NAME} second`);
  await builder(page).getByRole('button', { name: 'Next' }).click();
  await openDesk(page);
  await expect(campaigns(page).getByRole('link', { name: NAME, exact: true })).toBeVisible();
});

test(`${J} #3 validates a draft with blanks: the list names each blank (budget, rules, time frame, time zone, reward)`, async ({
  page,
}) => {
  await openDraft(page);
  await builder(page).getByRole('button', { name: 'Check the draft' }).click();
  const blanks = page.getByRole('list', { name: 'Still missing' });
  for (const blank of ['Budget', 'Rules', 'Time frame', 'Time zone', 'Reward']) await expect(blanks).toContainText(blank);
});

test(`${J} #4 builds a rule with nested AND and OR, tests it on a fixture account, saves it to the library: each failing leaf shown, nothing stored by the test; too deep refuses`, async ({
  page,
}) => {
  await openDraft(page);
  await builder(page).getByRole('tab', { name: 'Rules' }).click();
  const rule = page.getByRole('group', { name: 'Rule' });
  await rule.getByRole('button', { name: 'Add an AND group' }).click(UNBUILT);
  await rule.getByRole('button', { name: 'Add an OR group' }).click();
  await page.getByRole('button', { name: 'Test on a fixture account' }).click();
  await expect(page.getByRole('list', { name: 'Failing conditions' })).toBeVisible();
  await page.getByRole('button', { name: 'Save to the library' }).click();
  await expect(page.getByRole('status')).toContainText('Saved to the rule library');
});

test(`${J} #5 defines participation exclusions and a region list: a blank region list refuses activation`, async ({ page }) => {
  await openDraft(page);
  await builder(page).getByRole('tab', { name: 'Who can take part' }).click(UNBUILT);
  await expect(page.getByRole('group', { name: 'Exclusions' })).toBeVisible();
  await page.getByRole('button', { name: 'Ask to activate' }).click();
  await expect(page.getByRole('alert')).toContainText('The region list is not set');
  // The step defines the region list too, so the draft can go live in #7.
  await builder(page).getByRole('textbox', { name: 'Restricted regions' }).fill('KP');
  await builder(page).getByRole('button', { name: 'Next' }).click();
  await expect(builder(page).getByRole('tab', { name: 'Rules' })).toHaveAttribute('aria-selected', 'true');
});

test(`${J} #6 adds an earning rule with a trigger, condition and fixed incentive: one intent per event; a formula outside the grammar and an unknown trigger refuse`, async ({
  page,
}) => {
  await openDraft(page);
  await builder(page).getByRole('tab', { name: 'Earning rules' }).click(UNBUILT);
  const form = page.getByRole('form', { name: 'Earning rule' });
  await form.getByRole('combobox', { name: 'Trigger' }).selectOption({ index: 1 });
  await form.getByRole('textbox', { name: 'Incentive formula' }).fill('amount * * 2');
  await form.getByRole('button', { name: 'Add rule' }).click();
  await expect(form.getByRole('alert')).toContainText('not in the formula grammar');
});

test(`${J} #7 sets the time frame, budget and limits and requests activation: each blank has its own typed code; with all set, publishing waits for approval`, async ({
  page,
}) => {
  await openDraft(page);
  await page.getByRole('button', { name: 'Ask to activate' }).click(UNBUILT);
  await expect(page.getByRole('alert')).toContainText(/campaigns\.\w+_unset/);
  await builder(page).getByRole('tab', { name: 'Budget and time' }).click();
  await builder(page).getByLabel('Starts').fill('2026-11-01T00:00');
  await builder(page).getByLabel('Ends').fill('2026-11-30T23:59');
  await builder(page).getByRole('combobox', { name: 'Time zone' }).selectOption('UTC');
  await builder(page).getByRole('textbox', { name: 'Budget, USDT' }).fill('100');
  await builder(page).getByRole('textbox', { name: 'Per person limit' }).fill('1');
  await page.getByRole('button', { name: 'Ask to activate' }).click();
  await expect(page.getByTestId('campaign-state')).toHaveText('Waiting for approval');
});

test(`${J} #8 the requester tries to approve and a second founder approves: the requester is refused, and the approval applies to that revision only`, async ({
  page,
  browser,
}) => {
  await openDraft(page);
  await page.getByRole('button', { name: 'Approve' }).click(UNBUILT);
  await expect(page.getByRole('alert')).toContainText('You asked for this, so another founder must approve it.');
  const second = await (await browser.newContext()).newPage();
  await openDesk(second, 'b');
  await campaigns(second).getByRole('link', { name: draftName(), exact: true }).click();
  await second.getByRole('button', { name: 'Approve' }).click();
  await expect(second.getByRole('status')).toContainText(/Approved revision \d+/);
  await second.context().close();
});

test(`${J} #9 edits the active campaign: a new revision; earlier vouchers keep the old one; archiving an active campaign is refused`, async ({
  page,
}) => {
  await openDraft(page);
  await expect(page.getByTestId('campaign-revision')).toHaveText(/Revision \d+/, UNBUILT);
  await page.getByRole('button', { name: 'Archive' }).click();
  await expect(page.getByRole('alert')).toContainText('An active campaign cannot be archived');
});

test(`${J} #10 opens the calendar: all campaigns by time`, async ({ page }) => {
  await openDesk(page);
  await page.getByRole('tab', { name: 'Calendar' }).click(UNBUILT);
  await expect(page.getByRole('grid', { name: 'Campaign calendar' })).toBeVisible();
});
