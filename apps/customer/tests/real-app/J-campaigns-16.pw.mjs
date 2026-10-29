import { test, expect } from '@playwright/test';
import { ADMIN, founderSignIn } from './admin.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { api, journeyState, tool } from './stack.mjs';
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

// The builder's answers are read inside it: the console's route announcer is a second alert on every page.
const builder = (page) => page.getByRole('form', { name: 'Campaign builder' });
const campaigns = (page) => tableIn(page, 'Campaigns');

/** Pages already signed in: each sign-in waits for a fresh one-time code (up to 30 s), so a page signs in once. */
const signedIn = new WeakSet();

async function openDesk(page, founder = 'a') {
  if (!signedIn.has(page)) await founderSignIn(page, founder);
  signedIn.add(page);
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
}, testInfo) => {
  await openDraft(page);
  await builder(page).getByRole('tab', { name: 'Rules', exact: true }).click();
  const rule = page.getByRole('group', { name: 'Rule' });
  const library = page.getByRole('region', { name: 'Rule library' });
  // Each attempt saves its own name, so a retry starts from a library without it.
  const ruleName = `${draftName()} rule r${testInfo.retry}`;
  await page.getByRole('button', { name: 'Open the rule library' }).click(UNBUILT);
  await expect(library).toBeVisible();
  await expect(library).not.toContainText(ruleName);

  // Group 1 needs all of: an individual account (1.1), and either full verification (1.2.1) or a region other than KP (1.2.2).
  await rule.getByRole('button', { name: 'Add an AND group' }).click();
  await rule.getByRole('button', { name: 'Add an OR group' }).click();
  await rule.getByRole('button', { name: 'Add a condition' }).click();
  await rule.getByRole('combobox', { name: 'Field of condition 1.2.1' }).selectOption('kycTier');
  await rule.getByRole('combobox', { name: 'Verification of condition 1.2.1' }).selectOption('full');
  await rule.getByRole('combobox', { name: 'Field of condition 1.2.2' }).selectOption('region');

  // The TEST business account in KP, not verified, fails every leaf: each one is listed by its place.
  await page.getByLabel('Fixture account').selectOption('test-business-kp');
  await page.getByRole('button', { name: 'Test on a fixture account' }).click();
  const failing = page.getByRole('list', { name: 'Failing conditions' });
  await expect(failing.getByRole('listitem')).toHaveText([
    '1.1: Account type is individual',
    '1.2.1: Verification is at least full',
    '1.2.2: Region is not one of KP',
  ]);
  await expect(page.getByTestId('rule-test-result')).toContainText('The rule leaves this TEST account out. Nothing was read or stored.');
  // In DE with basic verification the OR group passes on its region, and its failing leaf is still listed.
  await page.getByLabel('Fixture account').selectOption('test-individual-de');
  await page.getByRole('button', { name: 'Test on a fixture account' }).click();
  await expect(page.getByTestId('rule-test-result')).toHaveAttribute('data-passes', 'true');
  await expect(failing.getByRole('listitem')).toHaveText(['1.2.1: Verification is at least full']);
  // An individual in FR with full verification holds every leaf: none is listed.
  await page.getByLabel('Fixture account').selectOption('test-individual-fr-frozen');
  await page.getByRole('button', { name: 'Test on a fixture account' }).click();
  await expect(page.getByTestId('rule-test-result')).toHaveAttribute('data-passes', 'true');
  await expect(failing.getByRole('listitem')).toHaveText(['None: every condition holds for this account.']);
  // Nothing was stored by the tests.
  await page.getByRole('button', { name: 'Open the rule library' }).click();
  await expect(library).not.toContainText(ruleName);

  await page.getByLabel('Rule name').fill(ruleName);
  await page.getByRole('button', { name: 'Save to the library' }).click();
  await expect(builder(page).getByRole('status')).toContainText(`Saved to the rule library as ${ruleName}, revision`);
  await page.getByRole('button', { name: 'Open the rule library' }).click();
  await expect(library).toContainText(`${ruleName}, revision`);

  // Four more groups inside group 1.2 nest the rule seven deep, past the depth limit: the try refuses by its code.
  for (let i = 0; i < 4; i += 1) await rule.getByRole('button', { name: 'Add an AND group' }).click();
  await page.getByRole('button', { name: 'Test on a fixture account' }).click();
  await expect(builder(page).getByRole('alert')).toContainText('campaigns.rule_too_deep');
  await expect(page.getByTestId('rule-test-result')).toHaveCount(0);
});

test(`${J} #5 defines participation exclusions and a region list: a blank region list refuses activation`, async ({ page }) => {
  await openDraft(page);
  await builder(page).getByRole('tab', { name: 'Who can take part' }).click(UNBUILT);
  await expect(page.getByRole('group', { name: 'Exclusions' })).toBeVisible();
  await page.getByRole('button', { name: 'Ask to activate' }).click();
  await expect(builder(page).getByRole('alert')).toContainText('The region list is not set');
  // The step defines the region list too, so the draft can go live in #7.
  await builder(page).getByRole('textbox', { name: 'Restricted regions' }).fill('KP');
  await builder(page).getByRole('button', { name: 'Next' }).click();
  await expect(builder(page).getByRole('tab', { name: 'Rules', exact: true })).toHaveAttribute('aria-selected', 'true');
});

test(`${J} #6 adds an earning rule with a trigger, condition and fixed incentive: one intent per event; a formula outside the grammar and an unknown trigger refuse`, async ({
  page,
}) => {
  await openDraft(page);
  await builder(page).getByRole('tab', { name: 'Earning rules' }).click();
  const form = page.getByRole('form', { name: 'Earning rule' });
  const rules = page.getByRole('list', { name: 'Earning rules' });
  await expect(form).toBeVisible(UNBUILT);
  // A retry starts from a draft without the rule an earlier attempt added.
  const earlier = page.getByRole('button', { name: 'Remove Deposit reward' });
  if (await earlier.count()) await earlier.click();
  await expect(rules).toHaveCount(0);
  await form.getByRole('textbox', { name: 'Earning rule name' }).fill('Deposit reward');

  // A formula outside the grammar refuses, and nothing is saved.
  await form.getByRole('combobox', { name: 'Trigger' }).selectOption('pay.deposit_credit.posted');
  await form.getByRole('textbox', { name: 'Incentive formula' }).fill('amount * * 2');
  await form.getByRole('button', { name: 'Add rule' }).click();
  await expect(form.getByRole('alert')).toContainText('not in the formula grammar');
  await expect(form.getByRole('alert')).toContainText('campaigns.formula_invalid');
  await expect(rules).toHaveCount(0);

  // A trigger outside the catalogue (sent as a tampered page would send it) refuses at the service by its code.
  await form
    .getByRole('combobox', { name: 'Trigger' })
    .evaluate((select) => select.add(new Option('Not in the catalogue', 'wallet.made.up')));
  await form.getByRole('combobox', { name: 'Trigger' }).selectOption('wallet.made.up');
  await form.getByRole('textbox', { name: 'Incentive formula' }).fill('1');
  await form.getByRole('button', { name: 'Add rule' }).click();
  await expect(form.getByRole('alert')).toContainText('campaigns.trigger_unknown');
  await expect(rules).toHaveCount(0);

  // A deposit of at least 10 gives a fixed 1, saved on the draft (it is still there after a reload).
  await form.getByRole('combobox', { name: 'Trigger' }).selectOption('pay.deposit_credit.posted');
  await form.getByLabel(/amount is at least/).fill('10');
  await form.getByRole('textbox', { name: 'Incentive formula' }).fill('1');
  await form.getByRole('button', { name: 'Add rule' }).click();
  await expect(form.getByRole('alert')).toHaveCount(0);
  await expect(rules.getByTestId('earning-rule')).toHaveCount(1);
  await expect(rules).toContainText('Deposit reward: when a crypto deposit is credited of at least 10, give 1');
  await page.reload();
  await builder(page).getByRole('tab', { name: 'Earning rules' }).click();
  await expect(page.getByRole('list', { name: 'Earning rules' })).toContainText('Deposit reward');
});

test(`${J} #7 sets the time frame, budget and limits and requests activation: each blank has its own typed code; with all set, publishing waits for approval`, async ({
  page,
}) => {
  await openDraft(page);
  await page.getByRole('button', { name: 'Ask to activate' }).click(UNBUILT);
  await expect(builder(page).getByRole('alert')).toContainText(/campaigns\.\w+_unset/);
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
  await expect(builder(page).getByRole('alert')).toContainText('You asked for this, so another founder must approve it.');
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
  const live = (await page.getByTestId('campaign-revision').textContent()) ?? '';
  // The edit is the next revision beside the live one, which stays live until another founder approves it.
  await builder(page).getByRole('tab', { name: 'Budget and time' }).click();
  await builder(page).getByRole('textbox', { name: 'Per person limit' }).fill('2');
  await builder(page).getByRole('button', { name: 'Next' }).click();
  await expect(page.getByTestId('campaign-pending')).toContainText(/Revision \d+, a draft/);
  await expect(page.getByTestId('campaign-revision')).toHaveText(live);
  await page.getByRole('button', { name: 'Archive' }).click();
  await expect(builder(page).getByRole('alert')).toContainText('An active campaign cannot be archived');
});

test(`${J} #10 opens the calendar: all campaigns by time`, async ({ page }) => {
  await openDesk(page);
  await page.getByRole('tab', { name: 'Calendar' }).click(UNBUILT);
  await expect(page.getByRole('grid', { name: 'Campaign calendar' })).toBeVisible();
});

// #6's other half: the rule pays one reward per event. The journey's own draft only goes live on its start date, so this
// part runs on a TEST campaign the two founders take live now through svc-campaigns' operator doors (A creates and asks, B
// approves, A activates), with the same earning rule. A customer joins it, then really deposits TEST USDT on the TEST chain
// (local-test-stack.mjs chain-deposit), and the chain delivers that one deposit three times.
let gates;
let ctx;
let pair;
const reply = (res, what) => {
  const row = res.json?.result?.data;
  if (!row) throw new Error(`${what} refused (${res.status}): ${res.text.slice(0, 300)}`);
  return row;
};

async function liveEarningCampaign(name) {
  gates ??= await import('../../../../tooling/scripts/local-test-gates.mjs');
  ctx ??= await gates.makeContext({ log: () => {} });
  pair ??= await gates.approverSessions(ctx);
  const a = await pair.a.campaignsOpsToken();
  const b = await pair.b.campaignsOpsToken();
  const definition = {
    name,
    type: 'task',
    rules: `TEST rules for ${name}: join, then deposit at least 10 USDT. Paid from the reward pot only.`,
    startsAt: new Date(Date.now() - 60_000).toISOString(),
    endsAt: new Date(Date.now() + 14 * 86_400_000).toISOString(),
    participation: { exclusions: [], regionScope: 'platform' },
    budget: { asset: 'USDT', limit: '100' },
    reward: { asset: 'USDT', amount: '5' },
    earning: [{ name: 'Deposit reward', trigger: 'pay.deposit_credit.posted', minAmount: '10', formula: '1' }],
  };
  const made = reply(await ctx.edge.mutate('campaigns', 'ops.campaigns.create', definition, a), 'ops.campaigns.create');
  reply(await ctx.edge.mutate('campaigns', 'ops.campaigns.transition', { id: made.id, action: 'submit', revision: 1 }, a), 'submit');
  reply(await ctx.edge.mutate('campaigns', 'ops.campaigns.transition', { id: made.id, action: 'approve', revision: 1 }, b), 'approve');
  const live = reply(
    await ctx.edge.mutate('campaigns', 'ops.campaigns.transition', { id: made.id, action: 'activate', revision: 1 }, a),
    'activate',
  );
  expect(live.state).toBe('active');
  return live;
}

/** The customer's TEST Ethereum USDT deposit address, read on Deposit as a person reads it. */
async function depositAddress(page) {
  await page.goto('/uc/recharge');
  await page.mouse.move(0, 600);
  await page.getByRole('combobox', { name: /^Asset Coins you hold/ }).selectOption('USDT');
  await page.getByRole('combobox', { name: 'Network', exact: true }).selectOption({ label: 'TEST Ethereum' });
  await page.getByRole('checkbox', { name: 'I will send only USDT on TEST Ethereum.' }).check();
  await page.getByRole('button', { name: 'Show my deposit address' }).click();
  return (await page.getByTestId('deposit-address').locator('strong[data-testid="numeric"]').innerText()).trim();
}

test(`${J} #6 the earning rule gives one intent per event: a deposit the chain delivers three times shows one reward, a second deposit a second`, async ({
  browser,
}, testInfo) => {
  test.setTimeout(240_000);
  const campaign = await liveEarningCampaign(`TEST earning ${Date.now().toString(36)}r${testInfo.retry}`);
  const page = await (await browser.newContext()).newPage();
  const who = await signUp(page, 'c16');
  await verify(page, who);
  await signIn(page, who);
  const joined = await (await api(who)).post('/api/campaigns/trpc/participation.join', { campaignId: campaign.id });
  expect(joined.body?.result?.data?.participation, JSON.stringify(joined.body).slice(0, 300)).toBeTruthy();

  const address = await depositAddress(page);
  const label = `jc16-${who.handle}-r${testInfo.retry}`;
  for (let i = 0; i < 3; i += 1) {
    expect(tool('local-test-stack.mjs', 'chain-deposit', address, 'USDT', '20', '6', '--tx', label)).toContain('"received":true');
  }

  await page.goto('/uc/promotion');
  const hub = page.getByTestId('rewards-hub');
  await expect(hub).not.toHaveAttribute('data-state', 'loading', { timeout: 30_000 });
  const rows = hub.locator(`[data-testid="reward-row"][data-campaign="${campaign.id}"]`);
  await expect(async () => {
    await page.reload();
    await expect(rows).toHaveCount(1, { timeout: 2_000 });
  }).toPass({ timeout: 60_000 });
  await expect(rows.getByTestId('reward-amount')).toContainText('1 USDT');
  // A moment later it is still the one reward: the second and third delivery gave nothing.
  await page.reload();
  await expect(rows).toHaveCount(1);

  // One per event, not one per person: a second, separate deposit is a new event and gives a second reward.
  expect(tool('local-test-stack.mjs', 'chain-deposit', address, 'USDT', '20', '6', '--tx', `${label}-2`)).toContain('"received":true');
  await expect(async () => {
    await page.reload();
    await expect(rows).toHaveCount(2, { timeout: 2_000 });
  }).toPass({ timeout: 60_000 });
});
