// World: none
import { randomBytes } from 'node:crypto';
import { test, expect } from './journey.mjs';
import { signIn } from './desk.mjs';
import { api, journeyState, signUpInBrowser, stepState } from './stack.mjs';
import { data, operatorPair } from './campaign-desk.mjs';

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

const state = stepState(run, J);
const operators = operatorPair();

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
  await expect(page.getByRole('heading', { level: 1, name: 'Campaigns', exact: true })).toBeVisible();
  await expect(page.getByTestId('campaign-catalogue').getByRole('status')).toHaveCount(0, { timeout: 30_000 });
}

/** A time as the campaign pages write it for a reader in `timeZone` (en, the zone named). */
const shown = (iso, timeZone) =>
  new Intl.DateTimeFormat('en', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
    timeZone,
  }).format(new Date(iso));
const tokyo = (iso) => shown(iso, 'Asia/Tokyo');

const card = (page, id) => page.locator(`[data-testid="campaign-card"][data-campaign-id="${id}"]`);

test(`${J} #1 /campaigns with nothing running shows the full catalogue layout and an honest empty state`, async ({
  browser,
  stepPicture,
}) => {
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
  await expect(page.getByTestId('campaign-type')).toHaveCount((await catalogueOf(me)).types.length);
  // The types section ends on the way to my campaigns.
  const toMine = page.getByTestId('campaign-types').locator('xpath=..').getByRole('link', { name: 'My campaigns', exact: true });
  await expect(toMine).toBeVisible();
  await expect(toMine).toHaveAttribute('href', '/campaigns/mine');
  // Nothing runs, and the page says so honestly: no invented card.
  expect((await catalogueOf(me)).campaigns).toEqual([]);
  await expect(page.getByTestId('campaign-card')).toHaveCount(0);
  await expect(page.getByTestId('campaign-catalogue')).toContainText('No campaign is running right now');
  // Its one action takes me to my campaigns and vouchers, where a voucher code is claimed.
  const action = page.getByTestId('campaign-catalogue').getByRole('link', { name: 'Claim a voucher code', exact: true });
  await expect(action).toBeVisible();
  await expect(action).toHaveAttribute('href', '/campaigns/mine');
  await expect(page.getByTestId('campaign-catalogue')).toContainText(
    'When a campaign is published it shows here with its dates, rules and reward, and you can join it from here.',
  );
  await stepPicture(page);
  run.write({ me });
});

test(`${J} #2 two active campaigns show their state, time frame and who can join; parked types show the blocker`, async ({
  browser,
  stepPicture,
}) => {
  const { me } = state('me');
  const first = await liveCampaign(`TEST tasks ${tag}`);
  // A referral campaign goes live only with its whole programme set (CM-referral-02): TEST criteria and a TEST reward per
  // side. It leaves business accounts out, so the two cards name two different groups who can join.
  const second = await liveCampaign(`TEST referral ${tag}`, {
    type: 'referral',
    reward: null,
    participation: { exclusions: ['business'], regionScope: 'platform' },
    referral: {
      sides: 'double',
      criteria: { verification: 'full', asset: 'USDT', depositMin: '20', tradeVolumeMin: '0.01', windowSeconds: 7 * 86_400 },
      rewards: { referrer: { asset: 'USDT', amount: '1' }, referee: { asset: 'USDT', amount: '1' } },
    },
  });
  // A parked type cannot go live: the founders' submit refuses it by name, so it is never a card.
  const { ctx, pair } = await operators();
  const a = await pair.a.campaignsOpsToken();
  const gift = data(
    await ctx.edge.mutate('campaigns', 'ops.campaigns.create', definition(`TEST gift card ${tag}`, { type: 'gift_card' }), a),
    'ops.campaigns.create',
  );
  const refused = await ctx.edge.mutate('campaigns', 'ops.campaigns.transition', { id: gift.id, action: 'submit', revision: 1 }, a);
  expect(refused.json?.error?.message ?? '').toContain('[owner.decision]');

  const page = await customer(browser);
  await signIn(page, me);
  await openCatalogue(page);
  const listed = (await catalogueOf(me)).campaigns;
  expect(listed.map((c) => c.id)).not.toContain(gift.id);
  await expect(card(page, gift.id)).toHaveCount(0);
  // Each card shows its state, its time frame (the stored one, read in my zone, UTC here) and who can join.
  const who = { [first.id]: 'Every signed-in account', [second.id]: 'Signed-in accounts except business accounts' };
  for (const c of [first, second]) {
    const row = card(page, c.id);
    const stored = listed.find((x) => x.id === c.id);
    expect(stored?.state).toBe('active');
    await expect(row).toBeVisible();
    await expect(row.getByRole('link', { name: c.name, exact: true })).toBeVisible();
    await expect(row.getByTestId('campaign-state')).toHaveText('Active');
    await expect(row.getByTestId('campaign-window')).toHaveText(`${shown(stored.startsAt, 'UTC')} to ${shown(stored.endsAt, 'UTC')}`);
    await expect(row.getByTestId('campaign-who')).toHaveText(who[c.id]);
  }
  // No invented card: the page draws exactly the campaigns the service lists.
  await expect(page.getByTestId('campaign-card')).toHaveCount(listed.length);
  const drawn = await page.getByTestId('campaign-card').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-campaign-id')));
  expect(drawn.toSorted()).toEqual(listed.map((c) => c.id).toSorted());
  // Filtering by type keeps the referral campaign only; Any brings both back.
  const typeFilter = page.getByRole('combobox', { name: 'Type', exact: true });
  await typeFilter.selectOption('referral');
  await expect(card(page, second.id)).toBeVisible();
  await expect(card(page, first.id)).toHaveCount(0);
  await typeFilter.selectOption('');
  await expect(card(page, first.id)).toBeVisible();
  await expect(card(page, second.id)).toBeVisible();
  // The gift-card and points types are visible and each names its blocker.
  const blockers = {
    gift_card: 'Waits for the owner to decide whether INTAFACED sells gift cards.',
    points: 'Waits for the owner to decide whether INTAFACED runs a points programme whose points have value.',
  };
  for (const [type, words] of Object.entries(blockers)) {
    const row = page.locator(`[data-testid="campaign-type"][data-type="${type}"]`);
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute('data-code', 'owner.decision');
    await expect(row).toContainText('Parked: waiting for an owner decision');
    await expect(row).toContainText(words);
  }
  await stepPicture(page);
  run.write({ ...run.read(), campaignId: first.id, campaignName: first.name });
});

test(`${J} #3 a campaign's page shows its rules, its time frame in my time zone, the budget left and the reward`, async ({
  browser,
  stepPicture,
}) => {
  const { me, campaignId, campaignName } = state('me', 'campaignId', 'campaignName');
  const { ctx, pair } = await operators();
  const a = await pair.a.campaignsOpsToken();
  // I read from Tokyo: the times are shown in my zone, with the zone named.
  const page = await customer(browser, 'Asia/Tokyo');
  await signIn(page, me);

  // The reward reads "not set" when the campaign has none: a TEST welcome campaign, whose reward is per task and left
  // blank here, shows its cap and "Not set" for the reward.
  const welcome = await liveCampaign(`TEST no reward ${tag}`, {
    type: 'welcome',
    reward: null,
    tasks: {
      steps: [{ title: 'TEST verify your identity', event: 'identity.verified', count: 1, reward: null }],
      claimWindowSeconds: null,
      holdSeconds: 0,
      kycGate: 'none',
      welcomeWindowSeconds: 86_400,
    },
  });
  try {
    await page.goto(`/campaigns/${welcome.id}`);
    const unset = page.getByTestId('campaign-detail');
    await expect(unset.getByRole('heading', { name: welcome.name, exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(unset.getByTestId('campaign-reward')).toHaveText(/^not set$/i);
    await expect(unset.getByTestId('campaign-budget-left')).toHaveText('1000 USDT of 1000 USDT');
  } finally {
    data(
      await ctx.edge.mutate('campaigns', 'ops.campaigns.transition', { id: welcome.id, action: 'end', revision: welcome.revision }, a),
      `end ${welcome.name}`,
    );
  }

  // The campaign I open from the catalogue: its page reads what the service stores.
  await openCatalogue(page);
  await card(page, campaignId).getByRole('link', { name: campaignName, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/campaigns/${campaignId}$`));
  const detail = page.getByTestId('campaign-detail');
  await expect(detail.getByRole('heading', { name: campaignName, exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(detail.getByTestId('campaign-rules')).toHaveText(
    `TEST rules for ${campaignName}: sign in and press Join. Nothing is paid by this TEST campaign.`,
  );
  await expect(detail.getByTestId('campaign-state')).toHaveText('Active');
  const stored = (await catalogueOf(me)).campaigns.find((c) => c.id === campaignId);
  expect(stored).toMatchObject({ budget: { limit: '1000', left: '1000', asset: 'USDT' }, reward: { amount: '10', asset: 'USDT' } });
  // The start and end converted to Tokyo time, the zone named.
  await expect(detail.getByText('Time frame, in your time zone', { exact: true })).toBeVisible();
  await expect(detail.getByTestId('campaign-window')).toHaveText(`${tokyo(stored.startsAt)} to ${tokyo(stored.endsAt)}`);
  await expect(detail.getByTestId('campaign-window')).toContainText('GMT+9');
  await expect(detail.getByTestId('campaign-days')).toHaveText('Every day');
  // The owner set a cap: the budget left is shown against it.
  await expect(detail.getByTestId('campaign-budget-left')).toHaveText('1000 USDT of 1000 USDT');
  await expect(detail.getByTestId('campaign-reward')).toHaveText('10 USDT');
  await stepPicture(page);
});

test(`${J} #3 a live campaign whose owner set no cap shows its page with no budget-left line`, async ({ browser, stepPicture }) => {
  const { me } = state('me');
  // A campaign the owner runs with no cap at all, a TEST trial pass (it pays nothing, so it asks for no budget), goes live.
  const pass = await liveCampaign(`TEST trial pass ${tag}`, {
    type: 'trial_pass',
    budget: null,
    reward: null,
    trialPass: { tierId: 'test-vip-1', seconds: 3600 },
  });
  expect(pass.budget ?? null).toBeNull();
  const { ctx, pair } = await operators();
  const a = await pair.a.campaignsOpsToken();
  try {
    const page = await customer(browser, 'Asia/Tokyo');
    await signIn(page, me);
    // An active campaign is a card I can open, cap or no cap.
    await openCatalogue(page);
    await card(page, pass.id).getByRole('link', { name: pass.name, exact: true }).click({ timeout: 15_000 });
    await expect(page).toHaveURL(new RegExp(`/campaigns/${pass.id}$`));
    const detail = page.getByTestId('campaign-detail');
    await expect(detail.getByRole('heading', { name: pass.name, exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(detail.getByTestId('campaign-rules')).toContainText(`TEST rules for ${pass.name}`);
    await expect(detail.getByTestId('campaign-window')).toContainText('GMT+9');
    await expect(detail.getByTestId('campaign-reward')).toHaveText(/^not set$/i);
    // No cap was set, so no budget left is shown.
    await expect(detail.getByText('Budget left', { exact: true })).toHaveCount(0);
    await expect(detail.getByTestId('campaign-budget-left')).toHaveCount(0);
    await stepPicture(page);
  } finally {
    data(
      await ctx.edge.mutate('campaigns', 'ops.campaigns.transition', { id: pass.id, action: 'end', revision: pass.revision }, a),
      `end ${pass.name}`,
    );
  }
});

test(`${J} #4 an excluded account type sees the typed reason and can ask for one review`, async ({ browser, stepPicture }) => {
  // A campaign that excludes business accounts (CM-eligibility-rules-01).
  const excluding = await liveCampaign(`TEST no business ${tag}`, {
    participation: { exclusions: ['business'], regionScope: 'platform' },
  });
  const firm = person(`jc01biz${tag}`.slice(0, 20));
  const page = await customer(browser);
  await signUpInBrowser(page, firm, { accountType: 'business' });
  await page.goto(`/campaigns/${excluding.id}`);
  const detail = page.getByTestId('campaign-detail');
  // The typed reason, in words and by its code; no Join button.
  const reason = detail.getByTestId('campaign-eligibility');
  await expect(reason).toHaveAttribute('data-code', 'campaigns.not_eligible', { timeout: 30_000 });
  await expect(reason).toHaveText('Can I take part: This campaign’s rules leave out your account, so you cannot join it.');
  await expect(detail.getByRole('button', { name: `Join ${excluding.name}`, exact: true })).toHaveCount(0);
  // A one-time review request: the page says it can be asked once, and once asked the button is gone.
  await expect(detail).toContainText('You can ask once per campaign.');
  await expect(detail.getByTestId('campaign-review')).toHaveCount(0);
  await detail.getByRole('button', { name: 'Ask for a review', exact: true }).click();
  await expect(detail.getByTestId('campaign-review')).toContainText('Review requested');
  await expect(detail.getByRole('button', { name: 'Ask for a review', exact: true })).toHaveCount(0);
  // Two more requests sent at once, as a retry and another tab would send them, both return the first one, not a new one.
  const firmApi = await api(firm);
  const [again, third] = await Promise.all(
    [1, 2].map(() => firmApi.post('/api/campaigns/trpc/participation.requestReview', { campaignId: excluding.id })),
  );
  expect(again.body?.result?.data?.created, JSON.stringify(again.body).slice(0, 300)).toBe(false);
  expect(third.body?.result?.data, JSON.stringify(third.body).slice(0, 300)).toEqual(again.body.result.data);
  // A fresh load still shows the one request, the same reason, and no button to ask again.
  const requested = await detail.getByTestId('campaign-review').innerText();
  await page.reload();
  await expect(detail.getByTestId('campaign-review')).toHaveText(requested, { timeout: 30_000 });
  await expect(reason).toHaveAttribute('data-code', 'campaigns.not_eligible');
  await expect(detail.getByRole('button', { name: 'Ask for a review', exact: true })).toHaveCount(0);
  await stepPicture(page);
});

test(`${J} #5 a region-scoped campaign from a blocked region shows the reason; another person gets the same answer`, async ({
  browser,
  stepPicture,
}) => {
  // A campaign scoped by a TEST region list that leaves France out (CM-eligibility-rules-01).
  const scoped = await liveCampaign(`TEST region ${tag}`, {
    participation: { exclusions: [], regionScope: 'listed', restrictedRegions: ['FR'] },
  });
  const seen = [];
  let page;
  for (const n of [1, 2]) {
    const who = person(`jc01fr${n}${tag}`.slice(0, 20));
    page = await customer(browser);
    await signUpInBrowser(page, who, { country: 'FR' });
    await page.goto(`/campaigns/${scoped.id}`);
    const detail = page.getByTestId('campaign-detail');
    const reason = detail.getByTestId('campaign-eligibility');
    await expect(reason).toHaveAttribute('data-code', 'campaigns.region_blocked', { timeout: 30_000 });
    // The reason is shown, and it is generic: it names no region and nothing about this person.
    await expect(reason).toHaveText('Can I take part: This campaign is not open in your region, so you cannot join it.');
    await expect(reason).not.toContainText(/FR|France/);
    await expect(reason).not.toContainText(who.handle);
    await expect(detail.getByRole('button', { name: `Join ${scoped.name}`, exact: true })).toHaveCount(0);
    // Probing the service directly gets the same refusal, and nothing is joined.
    const probe = await (await api(who)).post('/api/campaigns/trpc/participation.join', { campaignId: scoped.id });
    const refusal = probe.body?.error?.message;
    // The whole answer is the generic refusal and its typed code: no region, nothing about this person.
    expect(refusal, JSON.stringify(probe.body).slice(0, 300)).toBe('This campaign is not open in your region [campaigns.region_blocked]');
    expect(probe.body?.result).toBeUndefined();
    seen.push({ shown: await reason.innerText(), probe: refusal });
  }
  // The second person gets exactly the first person's answer, on the page and from the service.
  expect(seen[1]).toEqual(seen[0]);
  await stepPicture(page);
});

test(`${J} #6 pressing Join twice is one participation; a campaign outside its weekday or hour window refuses`, async ({
  browser,
  stepPicture,
}, testInfo) => {
  const { me } = state('me');
  // An active campaign I have not joined, made for this attempt, so a retry starts from the same place.
  const target = await liveCampaign(`TEST join ${tag} ${testInfo.retry}`);
  const page = await customer(browser);
  await signIn(page, me);
  const mine = await api(me);
  const before = await mine.get('/api/campaigns/trpc/participation.mine');
  expect(before.body?.result?.data?.campaigns.filter((m) => m.campaign.id === target.id)).toHaveLength(0);
  // Two devices on the same campaign, both showing Join: I press it on one, then on the other.
  const other = await customer(browser);
  await signIn(other, me);
  await page.goto(`/campaigns/${target.id}`);
  await other.goto(`/campaigns/${target.id}`);
  const detail = page.getByTestId('campaign-detail');
  const otherDetail = other.getByTestId('campaign-detail');
  const joinIn = (d) => d.getByRole('button', { name: `Join ${target.name}`, exact: true });
  await expect(joinIn(detail)).toBeVisible({ timeout: 30_000 });
  await expect(joinIn(otherDetail)).toBeVisible({ timeout: 30_000 });
  /** Press Join on `p` and read the service's own answer to that press. */
  const press = async (p, d) => {
    const reply = p.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes('/api/campaigns/trpc/participation.join'));
    await joinIn(d).click();
    return (await reply).json();
  };
  const first = await press(page, detail);
  await expect(detail.getByTestId('campaign-joined')).toContainText('Joined');
  const second = await press(other, otherDetail);
  await expect(otherDetail.getByTestId('campaign-joined')).toContainText('Joined');
  await expect(otherDetail.getByTestId('campaign-refusal')).toHaveCount(0);
  // The first press made the participation; the second returned that same one, not a new one.
  expect(first?.result?.data?.created, JSON.stringify(first).slice(0, 300)).toBe(true);
  expect(second?.result?.data?.created, JSON.stringify(second).slice(0, 300)).toBe(false);
  expect(second.result.data.participation).toEqual(first.result.data.participation);
  expect(first.result.data.participation.participationKey).toMatch(new RegExp(`^campaign:join:${target.id}:`));
  await expect(otherDetail.getByTestId('campaign-joined')).toHaveText(await detail.getByTestId('campaign-joined').innerText());
  const after = await mine.get('/api/campaigns/trpc/participation.mine');
  const rows = after.body?.result?.data?.campaigns.filter((m) => m.campaign.id === target.id);
  expect(rows).toHaveLength(1);
  expect(rows[0].participation).toEqual(first.result.data.participation);
  await other.close();
  run.write({ ...run.read(), joinedId: target.id, joinedName: target.name });

  // A campaign that runs on other weekdays only: neither today nor tomorrow in the platform time zone (UTC), so the step
  // holds across midnight.
  const today = ((new Date().getUTCDay() + 6) % 7) + 1;
  const tomorrow = (today % 7) + 1;
  const weekdays = [1, 2, 3, 4, 5, 6, 7].filter((d) => d !== today && d !== tomorrow);
  const closed = await liveCampaign(`TEST weekdays ${tag}`, { weekdays });
  await page.goto(`/campaigns/${closed.id}`);
  await detail.getByRole('button', { name: `Join ${closed.name}`, exact: true }).click({ timeout: 30_000 });
  await expect(detail.getByTestId('campaign-refusal')).toHaveAttribute('data-code', 'campaign.outside_window');
  await expect(detail.getByTestId('campaign-refusal')).toHaveText(
    'This campaign does not run at this time. Try again inside its days and hours.',
  );
  await expect(detail.getByTestId('campaign-joined')).toHaveCount(0);

  // A campaign that runs every day, but only in an hour window that has not begun yet in the platform time zone (UTC):
  // two hours from now when that is still today, else early tomorrow morning, so the step holds across midnight.
  const hour = new Date().getUTCHours();
  const from = hour <= 20 ? hour + 2 : 2;
  const hours = { from: `${String(from).padStart(2, '0')}:00`, to: `${String(from + 1).padStart(2, '0')}:00` };
  const later = await liveCampaign(`TEST hours ${tag}`, { hours });
  await page.goto(`/campaigns/${later.id}`);
  await expect(detail.getByTestId('campaign-hours')).toHaveText(`${hours.from} to ${hours.to} (UTC)`, { timeout: 30_000 });
  await detail.getByRole('button', { name: `Join ${later.name}`, exact: true }).click();
  await expect(detail.getByTestId('campaign-refusal')).toHaveAttribute('data-code', 'campaign.outside_window');
  await expect(detail.getByTestId('campaign-refusal')).toHaveText(
    'This campaign does not run at this time. Try again inside its days and hours.',
  );
  await expect(detail.getByTestId('campaign-joined')).toHaveCount(0);
  // Neither refused campaign became a participation.
  const last = await mine.get('/api/campaigns/trpc/participation.mine');
  const ids = last.body?.result?.data?.campaigns.map((m) => m.campaign.id);
  expect(ids).toContain(target.id);
  expect(ids).not.toContain(closed.id);
  expect(ids).not.toContain(later.id);
  run.write({ ...run.read(), refusedIds: [closed.id, later.id] });
  await stepPicture(page);
});

test(`${J} #7 /campaigns/mine shows the campaign I joined`, async ({ browser, stepPicture }) => {
  const { me, joinedId, joinedName, refusedIds } = state('me', 'joinedId', 'joinedName', 'refusedIds');
  const page = await customer(browser);
  await signIn(page, me);
  await page.goto('/campaigns/mine');
  const row = page.locator(`[data-testid="my-campaign"][data-campaign-id="${joinedId}"]`);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row.getByRole('link', { name: joinedName, exact: true })).toBeVisible();
  await expect(row).toContainText('Joined');
  // The campaign I joined shows once, the campaigns that refused me are not here, and no row is invented.
  await expect(row).toHaveCount(1);
  for (const id of refusedIds) await expect(page.locator(`[data-testid="my-campaign"][data-campaign-id="${id}"]`)).toHaveCount(0);
  const listed = (await (await api(me)).get('/api/campaigns/trpc/participation.mine')).body?.result?.data?.campaigns;
  expect(listed.map((m) => m.campaign.id)).toContain(joinedId);
  await expect(page.getByTestId('my-campaign')).toHaveCount(listed.length);
  await stepPicture(page);
});
