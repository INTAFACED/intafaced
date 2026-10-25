import { test, expect } from '@playwright/test';
import { ADMIN, founderSignIn } from './admin.mjs';
import { journeyState } from './stack.mjs';

// J-campaigns-16, in the running app (docs/roadmap/journeys.json): build a campaign and take it live. Founder A signs in to
// the founder console with their own sign-in and second factor, opens the campaigns desk at /more-ops/campaigns, builds a
// TEST task campaign step by step (every step saves the draft in svc-campaigns), checks it, sets who can take part, the
// time frame, the budget and the reward, and asks for approval. A cannot approve their own; founder B approves that
// revision on their own console and A takes it live. Every figure on the desk is svc-campaigns' answer, read back here
// through the same operator doors (the stack's LOCAL TEST founders, campaigns:ops). The amounts are TEST values.
// #4 (rule trees), #6 (earning rules) and #9 (a new revision of a live campaign) are later slices.
const J = 'J-campaigns-16';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

test.describe.configure({ mode: 'default' });
test.use({ timezoneId: 'UTC' });

function state(...keys) {
  const s = run.read();
  for (const k of keys) if (!s[k]) throw new Error(`${J}: an earlier step left no ${k}, so this step has nothing to act on`);
  return s;
}

let gates;
let ctx;
let pair;
async function operators() {
  gates ??= await import('../../../../tooling/scripts/local-test-gates.mjs');
  ctx ??= await gates.makeContext({ log: () => {} });
  pair ??= await gates.approverSessions(ctx);
  return { ctx, pair };
}

const data = (res, what) => {
  const row = res.json?.result?.data;
  if (row === undefined) throw new Error(`${what} refused (${res.status}): ${res.text.slice(0, 300)}`);
  return row;
};

/** What svc-campaigns holds, read through its operator door. */
async function opsList() {
  const { ctx, pair } = await operators();
  return data(await ctx.edge.query('campaigns', 'ops.campaigns.list', undefined, await pair.a.campaignsOpsToken()), 'ops.campaigns.list');
}
async function opsCampaign(id) {
  const row = (await opsList()).find((c) => c.id === id);
  if (!row) throw new Error(`${J}: svc-campaigns lists no campaign ${id}`);
  return row;
}
async function platformZone() {
  const { ctx, pair } = await operators();
  return data(await ctx.edge.query('campaigns', 'ops.campaigns.calendar', undefined, await pair.a.campaignsOpsToken()), 'calendar').timeZone;
}

async function founderPage(browser, key) {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: 'UTC' })).newPage();
  const founder = await founderSignIn(page, key);
  return { page, founder };
}

async function openDesk(page) {
  await page.goto(`${ADMIN}/more-ops/campaigns`, { waitUntil: 'load' });
  await expect(page.getByTestId('campaigns-desk')).toBeVisible({ timeout: 60_000 });
}

async function openBuilder(page, id) {
  await page.goto(`${ADMIN}/more-ops/campaigns/builder?id=${encodeURIComponent(id)}`, { waitUntil: 'load' });
  await expect(page.getByTestId('campaign-builder')).toHaveAttribute('data-campaign-id', id, { timeout: 60_000 });
  await expect(page.getByTestId('campaign-builder')).toHaveAttribute('data-ready', 'true');
}

const builder = (page) => page.getByTestId('campaign-builder');
const goToStep = (page, label) => page.getByTestId('campaign-steps').getByRole('button', { name: label }).click();
async function saveStep(page, step) {
  await page.getByTestId(`campaign-step-${step}`).getByRole('button', { name: /^Save/ }).click();
  await expect(page.getByTestId('campaign-outcome')).toContainText('Done: saved');
}
async function check(page) {
  await goToStep(page, '5. Check and go live');
  await page.getByRole('button', { name: 'Check what is missing' }).click();
}
const blanks = (page) => page.getByTestId('campaign-gate-blank');
async function blankCodes(page) {
  return (await blanks(page).evaluateAll((els) => els.map((e) => e.getAttribute('data-code')))).sort();
}

/** A UTC instant as the `datetime-local` value the founder types. */
const typed = (ms) => new Date(ms).toISOString().slice(0, 16);

test(`${J} #1 the campaigns desk shows what svc-campaigns holds, with honest empty states and no sample number`, async ({ browser }) => {
  run.reset({});
  const { page } = await founderPage(browser, 'a');
  await openDesk(page);
  const desk = page.getByTestId('campaigns-desk');
  for (const part of ['campaigns-overview', 'campaigns-drafts', 'campaigns-all', 'campaigns-calendar']) await expect(desk.getByTestId(part)).toBeVisible();
  await expect(desk.getByRole('link', { name: 'New campaign' })).toBeVisible();
  const listed = await opsList();
  // Every count is the service's: one per state it holds, and they sum to its list. On a fresh stack there is none.
  await expect(desk.getByTestId('campaign-row')).toHaveCount(listed.length);
  if (listed.length === 0) {
    await expect(desk.getByTestId('campaigns-overview-empty')).toContainText('No campaign exists yet');
    await expect(desk.getByTestId('campaigns-drafts')).toContainText('No draft.');
    await expect(desk.getByTestId('campaigns-calendar')).toContainText('No campaign has a time frame yet.');
  } else {
    const counts = await desk.getByTestId('campaigns-count').evaluateAll((els) => els.map((e) => [e.dataset.state, Number(e.querySelector('dd').textContent)]));
    const byState = {};
    for (const c of listed) byState[c.state] = (byState[c.state] ?? 0) + 1;
    expect(Object.fromEntries(counts)).toEqual(byState);
  }
});

test(`${J} #2 a draft resumes at the step where the founder left it, and a second draft leaves the first listed`, async ({ browser }) => {
  const { page, founder } = await founderPage(browser, 'a');
  await page.goto(`${ADMIN}/more-ops/campaigns/builder`, { waitUntil: 'load' });
  await expect(builder(page)).toHaveAttribute('data-step', 'basics', { timeout: 60_000 });
  await expect(builder(page)).toHaveAttribute('data-ready', 'true');
  const name = `TEST builder ${tag}`;
  await page.getByLabel('Name', { exact: true }).fill(name);
  await page.getByLabel('Type', { exact: true }).selectOption('task');
  await page.getByLabel('Rules customers read').fill(`TEST rules for ${name}: trade once. TEST amounts, nothing real is paid.`);
  await page.getByRole('button', { name: 'Save the draft and continue' }).click();
  await expect(builder(page)).toHaveAttribute('data-step', 'who', { timeout: 30_000 });
  await expect(builder(page)).not.toHaveAttribute('data-campaign-id', '');
  const id = await builder(page).getAttribute('data-campaign-id');
  const stored = await opsCampaign(id);
  expect(stored).toMatchObject({ name, type: 'task', state: 'draft', createdBy: founder.userId });

  // Leave for the desk: the draft is listed with the step it resumes at, and opening it lands there.
  await openDesk(page);
  const row = page.locator(`[data-testid="campaign-draft"][data-campaign-id="${id}"]`);
  await expect(row.getByTestId('campaign-resume-step')).toHaveText('2. Who can take part');
  await row.getByRole('link', { name }).click();
  await expect(builder(page)).toHaveAttribute('data-campaign-id', id, { timeout: 30_000 });
  await expect(builder(page)).toHaveAttribute('data-ready', 'true');
  await expect(builder(page)).toHaveAttribute('data-step', 'who');

  // A second draft is its own campaign; the first stays listed.
  await page.goto(`${ADMIN}/more-ops/campaigns/builder`, { waitUntil: 'load' });
  await expect(builder(page)).toHaveAttribute('data-ready', 'true', { timeout: 60_000 });
  await page.getByLabel('Name', { exact: true }).fill(`TEST second draft ${tag}`);
  await page.getByRole('button', { name: 'Save the draft and continue' }).click();
  await expect(builder(page)).not.toHaveAttribute('data-campaign-id', '', { timeout: 30_000 });
  const second = await builder(page).getAttribute('data-campaign-id');
  expect(second).not.toBe(id);
  await openDesk(page);
  await expect(page.locator(`[data-testid="campaign-draft"][data-campaign-id="${id}"]`)).toBeVisible();
  // A blank rules text resumes at the first step.
  await expect(page.locator(`[data-testid="campaign-draft"][data-campaign-id="${second}"]`).getByTestId('campaign-resume-step')).toHaveText(
    '1. Name, type and rules',
  );
  run.write({ id, name });
});

test(`${J} #3 checking a draft with blanks names each one by its code`, async ({ browser }) => {
  const { id } = state('id');
  const { page } = await founderPage(browser, 'a');
  await openBuilder(page, id);
  await check(page);
  await expect(blanks(page).first()).toBeVisible({ timeout: 30_000 });
  const zone = await platformZone();
  const expected = ['campaigns.budget_unset', 'campaigns.reward_unset', 'campaigns.rules_unset', 'campaigns.time_frame_unset'];
  if (!zone) expected.push('campaigns.timezone_unset');
  expect(await blankCodes(page)).toEqual(expected.sort());
  // The service's own gate says the same, and asking for approval refuses by the first blank's code.
  const { ctx, pair } = await operators();
  const gate = data(await ctx.edge.query('campaigns', 'ops.campaigns.validate', { id }, await pair.a.campaignsOpsToken()), 'validate');
  expect(gate.missing.map((m) => m.code).sort()).toEqual(expected.sort());
  await page.getByRole('button', { name: 'Ask for approval' }).click();
  await expect(page.getByTestId('campaign-outcome')).toHaveAttribute('data-code', 'campaigns.budget_unset');
  expect((await opsCampaign(id)).state).toBe('draft');
});

test(`${J} #5 exclusions and a listed region scope with a blank list refuse activation until the list is set`, async ({ browser }) => {
  const { id } = state('id');
  const { page } = await founderPage(browser, 'a');
  await openBuilder(page, id);
  await expect(builder(page)).toHaveAttribute('data-step', 'who');
  await page.getByLabel('Business accounts').check();
  await page.getByLabel('Every region except a restricted list').check();
  await saveStep(page, 'who');
  expect((await opsCampaign(id)).participation).toEqual({ exclusions: ['business'], regionScope: 'listed', restrictedRegions: null });
  await check(page);
  await expect(page.locator('[data-testid="campaign-gate-blank"][data-code="campaigns.region_list_unset"]')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-testid="campaign-gate-blank"][data-code="campaigns.rules_unset"]')).toHaveCount(0);

  // A code that is not a region is named before anything is sent; a real list clears the blank.
  await goToStep(page, '2. Who can take part');
  await page.getByLabel('Restricted regions').fill('KP, Iran');
  await page.getByTestId('campaign-step-who').getByRole('button', { name: /^Save/ }).click();
  await expect(page.getByTestId('campaign-outcome')).toContainText('"Iran" is not a two-letter region code');
  await page.getByLabel('Restricted regions').fill('KP, ir');
  await saveStep(page, 'who');
  expect((await opsCampaign(id)).participation).toEqual({ exclusions: ['business'], regionScope: 'listed', restrictedRegions: ['IR', 'KP'] });
  await check(page);
  await expect(blanks(page).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-testid="campaign-gate-blank"][data-code="campaigns.region_list_unset"]')).toHaveCount(0);
});

test(`${J} #7 the time frame, budget and reward clear their own blanks; with all set, the request waits for approval`, async ({ browser }) => {
  const { id } = state('id');
  const { page, founder } = await founderPage(browser, 'a');
  await openBuilder(page, id);
  await expect(builder(page)).toHaveAttribute('data-step', 'time');
  const starts = Date.now() - 60_000;
  const ends = Date.now() + 14 * 86_400_000;
  await page.getByLabel('Starts (UTC)').fill(typed(starts));
  await page.getByLabel('Ends (UTC)').fill(typed(ends));
  await saveStep(page, 'time');
  const timed = await opsCampaign(id);
  expect(timed.startsAt).toBe(`${typed(starts)}:00.000Z`);
  expect(timed.endsAt).toBe(`${typed(ends)}:00.000Z`);
  await check(page);
  await expect(blanks(page).first()).toBeVisible({ timeout: 30_000 });
  expect(await blankCodes(page)).toEqual(['campaigns.budget_unset', 'campaigns.reward_unset']);

  // A budget alone leaves the reward blank, by its own code.
  await goToStep(page, '4. Budget and reward');
  await page.getByLabel('Budget limit').fill('1000');
  await page.getByLabel('Budget asset').fill('USDT');
  await saveStep(page, 'money');
  await check(page);
  await expect(page.locator('[data-testid="campaign-gate-blank"]')).toHaveCount(1, { timeout: 30_000 });
  expect(await blankCodes(page)).toEqual(['campaigns.reward_unset']);
  await goToStep(page, '4. Budget and reward');
  await page.getByLabel('Reward per customer').fill('10');
  await page.getByLabel('Reward asset').fill('USDT');
  await saveStep(page, 'money');
  await expect(builder(page)).toHaveAttribute('data-step', 'review');
  await page.getByRole('button', { name: 'Check what is missing' }).click();
  await expect(page.getByTestId('campaign-gate-clear')).toBeVisible({ timeout: 30_000 });

  // Every blank is set: asking for approval moves it to waiting, and nothing is live yet.
  await page.getByRole('button', { name: 'Ask for approval' }).click();
  await expect(page.getByTestId('campaign-outcome')).toContainText('Done: submit');
  await expect(page.getByTestId('campaign-summary').getByTestId('campaign-state')).toHaveAttribute('data-state', 'pending_approval');
  await expect(page.getByTestId('campaign-waits-approval')).toBeVisible();
  const asked = await opsCampaign(id);
  expect(asked).toMatchObject({ state: 'pending_approval', submittedBy: founder.userId, approvedBy: null, budget: { asset: 'USDT', limit: '1000', left: '1000' } });
  run.write({ revision: asked.revision });
});

test(`${J} #8 the requester cannot approve; a second founder approves that revision and it goes live`, async ({ browser }) => {
  const { id, revision } = state('id', 'revision');
  const a = await founderPage(browser, 'a');
  await openBuilder(a.page, id);
  await expect(builder(a.page)).toHaveAttribute('data-step', 'review');
  await a.page.getByRole('button', { name: 'Approve this revision' }).click();
  await expect(a.page.getByTestId('campaign-outcome')).toHaveAttribute('data-code', 'campaigns.second_person_required');
  expect((await opsCampaign(id)).state).toBe('pending_approval');

  const b = await founderPage(browser, 'b');
  await openBuilder(b.page, id);
  await expect(b.page.getByTestId('campaign-revision')).toHaveText(String(revision));
  await b.page.getByRole('button', { name: 'Approve this revision' }).click();
  await expect(b.page.getByTestId('campaign-outcome')).toContainText('Done: approve');
  await expect(b.page.getByTestId('campaign-approved-by')).toHaveText(b.founder.userId);
  const approved = await opsCampaign(id);
  expect(approved).toMatchObject({ state: 'approved', revision, approvedBy: b.founder.userId });

  // The approval is of this revision: the definition is no longer a draft, so it cannot change under the approval.
  const { ctx, pair } = await operators();
  const edit = await ctx.edge.mutate(
    'campaigns',
    'ops.campaigns.update',
    { id, revision, definition: { name: approved.name, type: 'task', rules: 'TEST changed after approval' } },
    await pair.a.campaignsOpsToken(),
  );
  expect(edit.json?.error?.message ?? '').toContain('campaign.not_draft');

  await openBuilder(a.page, id);
  await expect(builder(a.page)).toHaveAttribute('data-step', 'review');
  await a.page.getByRole('button', { name: 'Take it live' }).click();
  await expect(a.page.getByTestId('campaign-outcome')).toContainText('Done: activate');
  await expect(a.page.getByTestId('campaign-summary').getByTestId('campaign-state')).toHaveAttribute('data-state', 'active');
  expect((await opsCampaign(id)).state).toBe('active');
});

test(`${J} #10 the calendar lists every campaign by its time frame`, async ({ browser }) => {
  const { id, name } = state('id', 'name');
  const { page } = await founderPage(browser, 'a');
  await openDesk(page);
  const calendar = page.getByTestId('campaigns-calendar');
  const { ctx, pair } = await operators();
  const answer = data(await ctx.edge.query('campaigns', 'ops.campaigns.calendar', undefined, await pair.a.campaignsOpsToken()), 'calendar');
  await expect(calendar.getByTestId('campaign-calendar-entry')).toHaveCount(answer.entries.length);
  // By start, as the service orders them.
  const shown = await calendar.getByTestId('campaign-calendar-entry').evaluateAll((els) => els.map((e) => e.getAttribute('data-campaign-id')));
  expect(shown).toEqual(answer.entries.map((e) => e.id));
  const entry = calendar.locator(`[data-testid="campaign-calendar-entry"][data-campaign-id="${id}"]`);
  await expect(entry).toContainText(name);
  await expect(entry.getByTestId('campaign-state')).toHaveAttribute('data-state', 'active');
  if (answer.timeZone) await expect(calendar.getByTestId('campaigns-calendar-zone')).toContainText(`Platform time zone: ${answer.timeZone}`);
});
