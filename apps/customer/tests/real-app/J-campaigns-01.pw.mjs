import { randomBytes } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { signIn } from './desk.mjs';
import { api, journeyState, signUpInBrowser } from './stack.mjs';

// J-campaigns-01, in the running app (docs/roadmap/journeys.json): find a campaign I can take part in and join it.
// One test per step, titled "J-campaigns-01 #<n>", run in order. The campaigns are this run's TEST campaigns, made by the
// stack's two LOCAL TEST founders through svc-campaigns' operator doors: A creates and asks, B approves, A activates.
// The platform time zone is the stack's labelled TEST value (CAMPAIGNS_PLATFORM_TIME_ZONE, UTC, in
// tooling/profiles/test-owner-values/campaigns.json). The customer signs up on the Customer app and reads /campaigns.
// #4 and #5 read participation rules and region lists (CM-eligibility-rules-01): svc-campaigns asks svc-identity for the
// account type and the region chosen at sign-up. The region list is a TEST list made for this run.
const J = 'J-campaigns-01';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

test.describe.configure({ mode: 'default' });

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
  if (!row) throw new Error(`${what} refused (${res.status}): ${res.text.slice(0, 300)}`);
  return row;
};

const DAY = 86_400_000;

/** A full TEST definition: every field the activation gate needs is set. */
const definition = (name, over = {}) => ({
  name,
  type: 'task',
  rules: `TEST rules for ${name}: sign in and press Join. Nothing is paid by this TEST campaign.`,
  startsAt: new Date(Date.now() - 60_000).toISOString(),
  endsAt: new Date(Date.now() + 14 * DAY).toISOString(),
  participation: { exclusions: [], regionScope: 'platform' },
  budget: { asset: 'USDT', limit: '1000' },
  // TEST limits (CM-eligibility-rules-03), wide enough that only a step about limits meets them.
  limits: { perCustomer: { count: 100, periodSeconds: 86_400 }, totalRedemptions: null },
  reward: { asset: 'USDT', amount: '10' },
  ...over,
});

/** Founder A creates and asks, founder B approves, A activates. The creator cannot approve their own. */
async function liveCampaign(name, over = {}) {
  const { ctx, pair } = await operators();
  const a = await pair.a.campaignsOpsToken();
  const b = await pair.b.campaignsOpsToken();
  const made = data(await ctx.edge.mutate('campaigns', 'ops.campaigns.create', definition(name, over), a), 'ops.campaigns.create');
  data(await ctx.edge.mutate('campaigns', 'ops.campaigns.transition', { id: made.id, action: 'submit', revision: 1 }, a), 'submit');
  const self = await ctx.edge.mutate('campaigns', 'ops.campaigns.transition', { id: made.id, action: 'approve', revision: 1 }, a);
  expect(self.json?.error?.message ?? '').toContain('campaigns.second_person_required');
  data(await ctx.edge.mutate('campaigns', 'ops.campaigns.transition', { id: made.id, action: 'approve', revision: 1 }, b), 'approve');
  const live = data(
    await ctx.edge.mutate('campaigns', 'ops.campaigns.transition', { id: made.id, action: 'activate', revision: 1 }, a),
    'activate',
  );
  expect(live.state).toBe('active');
  return live;
}

/**
 * The step's starting point, nothing running: founder A ends every TEST campaign that is scheduled, active or paused on
 * this stack (earlier journeys in the same run leave theirs live), and any older one the customer `who` still sees.
 * Ending moves nothing and is what an operator does.
 */
async function endEveryRunningCampaign(who) {
  const { ctx, pair } = await operators();
  const a = await pair.a.campaignsOpsToken();
  const all = data(await ctx.edge.query('campaigns', 'ops.campaigns.list', undefined, a), 'ops.campaigns.list');
  const running = all.filter((x) => ['scheduled', 'active', 'paused'].includes(x.state));
  // The ops list is the newest 200; anything older the customer still sees is read by id.
  for (const { id } of (await catalogueOf(who)).campaigns.filter((x) => !running.some((c) => c.id === x.id))) {
    running.push(data(await ctx.edge.query('campaigns', 'ops.campaigns.get', { id }, a), `ops.campaigns.get ${id}`));
  }
  for (const c of running) {
    const ended = data(
      await ctx.edge.mutate('campaigns', 'ops.campaigns.transition', { id: c.id, action: 'end', revision: c.revision }, a),
      `end ${c.name}`,
    );
    expect(ended.state).toBe('ended');
  }
}

const person = (handle) => ({
  handle,
  email: `${handle}@local-test.invalid`,
  password: `TEST-${randomBytes(9).toString('base64url')}-9a`,
});

/** A signed-in customer on a device of its own, in a time zone of its own. */
async function customer(browser, timezoneId = 'UTC') {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId });
  return context.newPage();
}

async function catalogueOf(who) {
  const res = await (await api(who)).get('/api/campaigns/trpc/catalogue.list');
  if (!res.body?.result) throw new Error(`catalogue.list refused (${res.status}): ${JSON.stringify(res.body).slice(0, 300)}`);
  return res.body.result.data;
}

async function openCatalogue(page) {
  await page.goto('/campaigns');
  await expect(page.getByRole('heading', { level: 1, name: 'Campaigns' })).toBeVisible();
  await expect(page.getByTestId('campaign-catalogue').getByRole('status')).toHaveCount(0, { timeout: 30_000 });
}

const card = (page, id) => page.locator(`[data-testid="campaign-card"][data-campaign-id="${id}"]`);

test(`${J} #1 /campaigns with nothing running shows the full catalogue layout and an honest empty state`, async ({ browser }) => {
  run.reset({});
  const me = person(`jc01me${tag}`.slice(0, 20));
  const page = await customer(browser);
  await signUpInBrowser(page, me);
  await endEveryRunningCampaign(me);
  await openCatalogue(page);
  // The filters and the type list are always laid out.
  await expect(page.getByRole('combobox', { name: 'Type', exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'State', exact: true })).toBeVisible();
  await expect(page.getByTestId('campaign-types')).toBeVisible();
  // Nothing runs, and the page says so honestly: no invented card.
  expect((await catalogueOf(me)).campaigns).toEqual([]);
  await expect(page.getByTestId('campaign-card')).toHaveCount(0);
  await expect(page.getByTestId('campaign-catalogue')).toContainText('No campaign is running right now');
  run.write({ me });
});

test(`${J} #2 two active campaigns show their state, time frame and who can join; parked types show the blocker`, async ({ browser }) => {
  const { me } = state('me');
  const first = await liveCampaign(`TEST tasks ${tag}`);
  const second = await liveCampaign(`TEST referral ${tag}`, { type: 'referral' });
  const page = await customer(browser);
  await signIn(page, me);
  await openCatalogue(page);
  for (const c of [first, second]) {
    const row = card(page, c.id);
    await expect(row).toBeVisible();
    await expect(row.getByRole('link', { name: c.name })).toBeVisible();
    await expect(row.getByTestId('campaign-state')).toHaveText('Active');
    await expect(row.getByTestId('campaign-window')).toContainText(' to ');
    await expect(row.getByTestId('campaign-who')).toHaveText('Every signed-in account');
  }
  // The gift-card and points types are visible and name their blocker.
  for (const type of ['gift_card', 'points']) {
    const row = page.locator(`[data-testid="campaign-type"][data-type="${type}"]`);
    await expect(row).toHaveAttribute('data-code', 'owner.decision');
    await expect(row).toContainText('Parked: waiting for an owner decision');
  }
  await expect(page.getByTestId('campaign-types')).toContainText('Waits for the owner to decide whether INTAFACED sells gift cards');
  // A parked type cannot go live: the founders' activation refuses by name.
  const { ctx, pair } = await operators();
  const a = await pair.a.campaignsOpsToken();
  const gift = data(
    await ctx.edge.mutate('campaigns', 'ops.campaigns.create', definition(`TEST gift card ${tag}`, { type: 'gift_card' }), a),
    'ops.campaigns.create',
  );
  const refused = await ctx.edge.mutate('campaigns', 'ops.campaigns.transition', { id: gift.id, action: 'submit', revision: 1 }, a);
  expect(refused.json?.error?.message ?? '').toContain('[owner.decision]');
  // Filtering by type keeps the referral campaign only.
  await page.getByRole('combobox', { name: 'Type', exact: true }).selectOption('referral');
  await expect(card(page, second.id)).toBeVisible();
  await expect(card(page, first.id)).toHaveCount(0);
  run.write({ ...run.read(), campaignId: first.id, campaignName: first.name });
});

test(`${J} #3 a campaign's page shows its rules, its time frame in my time zone, the budget left and the reward`, async ({ browser }) => {
  const { me, campaignId, campaignName } = state('me', 'campaignId', 'campaignName');
  // I read it from Tokyo: the times are shown in my zone, with the zone named.
  const page = await customer(browser, 'Asia/Tokyo');
  await signIn(page, me);
  await openCatalogue(page);
  await card(page, campaignId).getByRole('link', { name: campaignName }).click();
  await expect(page).toHaveURL(new RegExp(`/campaigns/${campaignId}$`));
  const detail = page.getByTestId('campaign-detail');
  await expect(detail.getByRole('heading', { name: campaignName })).toBeVisible({ timeout: 30_000 });
  await expect(detail.getByTestId('campaign-rules')).toContainText(`TEST rules for ${campaignName}`);
  await expect(detail.getByTestId('campaign-state')).toHaveText('Active');
  await expect(detail.getByTestId('campaign-window')).toContainText('GMT+9');
  await expect(detail.getByTestId('campaign-days')).toHaveText('Every day');
  await expect(detail.getByTestId('campaign-budget-left')).toHaveText('1000 USDT of 1000 USDT');
  await expect(detail.getByTestId('campaign-reward')).toHaveText('10 USDT');
  // The page reads what the service stores.
  const stored = (await catalogueOf(me)).campaigns.find((c) => c.id === campaignId);
  expect(stored).toMatchObject({ budget: { limit: '1000', left: '1000', asset: 'USDT' }, reward: { amount: '10', asset: 'USDT' } });
});

test(`${J} #4 an excluded account type sees the typed reason and can ask for one review`, async ({ browser }) => {
  // A campaign that excludes business accounts (CM-eligibility-rules-01).
  const excluding = await liveCampaign(`TEST no business ${tag}`, {
    participation: { exclusions: ['business'], regionScope: 'platform' },
  });
  const firm = person(`jc01biz${tag}`.slice(0, 20));
  const page = await customer(browser);
  await signUpInBrowser(page, firm, { accountType: 'business' });
  await page.goto(`/campaigns/${excluding.id}`);
  const detail = page.getByTestId('campaign-detail');
  await expect(detail.getByTestId('campaign-eligibility')).toHaveAttribute('data-code', 'campaigns.not_eligible', { timeout: 30_000 });
  await detail.getByRole('button', { name: 'Ask for a review' }).click();
  await expect(detail.getByTestId('campaign-review')).toContainText('Review requested');
  await expect(detail.getByRole('button', { name: 'Ask for a review' })).toHaveCount(0);
  // One review only: two more requests sent at once, as a retry and another tab would send them, both return the
  // first, and a fresh load of the page still shows it requested with no button to ask again.
  const api1 = await api(firm);
  const [first, second] = await Promise.all(
    [1, 2].map(() => api1.post('/api/campaigns/trpc/participation.requestReview', { campaignId: excluding.id })),
  );
  expect(first.body?.result?.data?.created, JSON.stringify(first.body).slice(0, 300)).toBe(false);
  expect(second.body?.result?.data, JSON.stringify(second.body).slice(0, 300)).toEqual(first.body.result.data);
  await page.reload();
  await expect(detail.getByTestId('campaign-review')).toContainText('Review requested', { timeout: 30_000 });
  await expect(detail.getByRole('button', { name: 'Ask for a review' })).toHaveCount(0);
});

test(`${J} #5 a region-scoped campaign from a blocked region shows the reason; another person gets the same answer`, async ({
  browser,
}) => {
  // A campaign scoped by a TEST region list that leaves France out (CM-eligibility-rules-01).
  const scoped = await liveCampaign(`TEST region ${tag}`, {
    participation: { exclusions: [], regionScope: 'listed', restrictedRegions: ['FR'] },
  });
  const answers = [];
  for (const n of [1, 2]) {
    const who = person(`jc01fr${n}${tag}`.slice(0, 20));
    const page = await customer(browser);
    await signUpInBrowser(page, who, { country: 'FR' });
    await page.goto(`/campaigns/${scoped.id}`);
    const reason = page.getByTestId('campaign-detail').getByTestId('campaign-eligibility');
    await expect(reason).toHaveAttribute('data-code', 'campaigns.region_blocked', { timeout: 30_000 });
    answers.push(await reason.innerText());
  }
  expect(answers[1]).toBe(answers[0]);
});

test(`${J} #6 pressing Join twice is one participation; a campaign outside its weekday window refuses`, async ({ browser }) => {
  const { me, campaignId, campaignName } = state('me', 'campaignId', 'campaignName');
  const page = await customer(browser);
  await signIn(page, me);
  await page.goto(`/campaigns/${campaignId}`);
  const detail = page.getByTestId('campaign-detail');
  await detail.getByRole('button', { name: `Join ${campaignName}` }).click();
  await expect(detail.getByTestId('campaign-joined')).toContainText('Joined');
  // The second press, as a lost reply's retry would make it: the same participation comes back.
  const mine = await api(me);
  const again = await mine.post('/api/campaigns/trpc/participation.join', { campaignId });
  expect(again.body?.result?.data?.created).toBe(false);
  expect(again.body.result.data.participation.participationKey).toMatch(new RegExp(`^campaign:join:${campaignId}:`));
  const list = await mine.get('/api/campaigns/trpc/participation.mine');
  expect(list.body?.result?.data?.campaigns.filter((m) => m.campaign.id === campaignId)).toHaveLength(1);
  await page.reload();
  await expect(detail.getByTestId('campaign-joined')).toBeVisible();

  // A campaign that runs on other weekdays only: neither today nor tomorrow in the platform time zone (UTC), so the step
  // holds across midnight.
  const today = ((new Date().getUTCDay() + 6) % 7) + 1;
  const tomorrow = (today % 7) + 1;
  const weekdays = [1, 2, 3, 4, 5, 6, 7].filter((d) => d !== today && d !== tomorrow);
  const closed = await liveCampaign(`TEST weekdays ${tag}`, { weekdays });
  await page.goto(`/campaigns/${closed.id}`);
  await detail.getByRole('button', { name: `Join ${closed.name}` }).click();
  await expect(detail.getByTestId('campaign-refusal')).toHaveAttribute('data-code', 'campaign.outside_window');
  await expect(detail.getByTestId('campaign-refusal')).toContainText('does not run at this time');
  await expect(detail.getByTestId('campaign-joined')).toHaveCount(0);
});

test(`${J} #7 /campaigns/mine shows the campaign I joined`, async ({ browser }) => {
  const { me, campaignId, campaignName } = state('me', 'campaignId', 'campaignName');
  const page = await customer(browser);
  await signIn(page, me);
  await page.goto('/campaigns/mine');
  const row = page.locator(`[data-testid="my-campaign"][data-campaign-id="${campaignId}"]`);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row.getByRole('link', { name: campaignName })).toBeVisible();
  await expect(row).toContainText('Joined');
  await expect(page.getByTestId('my-campaign')).toHaveCount(1);
});
