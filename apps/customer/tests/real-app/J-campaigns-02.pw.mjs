import { randomBytes } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { openDesk, signIn } from './desk.mjs';
import { api, fund, journeyState, signOutBrowser, signUpInBrowser, tool } from './stack.mjs';

// J-campaigns-02, in the running app (docs/roadmap/journeys.json): finish a task campaign and receive the reward.
// One test per step, titled "J-campaigns-02 #<n>", run in order. The task campaign is this run's TEST campaign, made by the
// stack's two LOCAL TEST founders through svc-campaigns' operator doors (A creates and asks, B approves, A activates).
// Its steps complete only from svc-trade's settled fills on the bus (trade.fill.settled): the customer really trades
// BTC/USDT against the stack's market maker. Its claim needs full verification; the customer starts with basic, which
// trading needs. The reward is TEST USDT from the one reward pot, which the two founders fund from trade fees the
// platform earned (sweepFeesToRewards: A asks, B approves). The reconciler interval and the rollback window are the stack's
// labelled TEST values (tooling/profiles/test-owner-values/campaigns.json).
const J = 'J-campaigns-02';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const SYMBOL = 'BTC/USDT';
const TRADE = '0.001';
const REWARD = '0.01';

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

/** A TEST task campaign: every field the activation gate needs is set. */
const definition = (name, tasks, over = {}) => ({
  name,
  type: 'task',
  rules: `TEST rules for ${name}: do the steps by trading BTC/USDT, then claim. The reward is TEST USDT.`,
  startsAt: new Date(Date.now() - 60_000).toISOString(),
  endsAt: new Date(Date.now() + 14 * DAY).toISOString(),
  participation: { exclusions: [], regionScope: 'platform' },
  budget: { asset: 'USDT', limit: '0.05' },
  reward: { asset: 'USDT', amount: REWARD },
  tasks,
  ...over,
});

const THREE_STEPS = {
  steps: [
    { title: 'TEST buy BTC', event: 'trade.fill', market: SYMBOL, side: 'buy', count: 1 },
    { title: 'TEST sell BTC', event: 'trade.fill', market: SYMBOL, side: 'sell', count: 1 },
    { title: 'TEST trade three times', event: 'trade.fill', market: SYMBOL, side: null, count: 3 },
  ],
  claimWindowSeconds: 3600,
  kycGate: 'full',
};

async function liveCampaign(name, tasks) {
  const { ctx, pair } = await operators();
  const a = await pair.a.campaignsOpsToken();
  const b = await pair.b.campaignsOpsToken();
  const made = data(await ctx.edge.mutate('campaigns', 'ops.campaigns.create', definition(name, tasks), a), 'ops.campaigns.create');
  data(await ctx.edge.mutate('campaigns', 'ops.campaigns.transition', { id: made.id, action: 'submit', revision: 1 }, a), 'submit');
  data(await ctx.edge.mutate('campaigns', 'ops.campaigns.transition', { id: made.id, action: 'approve', revision: 1 }, b), 'approve');
  const live = data(
    await ctx.edge.mutate('campaigns', 'ops.campaigns.transition', { id: made.id, action: 'activate', revision: 1 }, a),
    'activate',
  );
  expect(live.state).toBe('active');
  return live;
}

/** Founder A asks to sweep earned trade fees into the reward pot; founder B approves, which posts it. */
async function fundPot(reference, amount) {
  const { ctx, pair } = await operators();
  const a = await pair.a.campaignsOpsToken();
  const b = await pair.b.campaignsOpsToken();
  data(
    await ctx.edge.mutate('campaigns', 'ops.pot.request', { reference, sourceModule: 'trade', asset: 'USDT', amount }, a),
    'ops.pot.request',
  );
  const self = await ctx.edge.mutate('campaigns', 'ops.pot.approve', { reference }, a);
  expect(self.json?.error?.message ?? '').toContain('campaigns.second_person_required');
  const funded = data(await ctx.edge.mutate('campaigns', 'ops.pot.approve', { reference }, b), 'ops.pot.approve');
  expect(funded.state, JSON.stringify(funded)).toBe('posted');
  return funded;
}

const person = (handle) => ({
  handle,
  email: `${handle}@local-test.invalid`,
  password: `TEST-${randomBytes(9).toString('base64url')}-9a`,
});

/** Asks for a verification level on /verification; the two TEST operators approve it (local-test-gates.mjs verify). */
async function verifyAs(page, who, level, tier) {
  await signIn(page, who);
  await page.goto('/verification');
  await page.getByLabel('Level to request').selectOption({ label: level });
  await page.getByLabel('Country code').fill('DE');
  await page.getByRole('button', { name: 'Review request' }).click();
  await page.getByRole('button', { name: 'Submit this request' }).click();
  await expect(page.getByText('Your reviewed request')).toBeVisible();
  tool('local-test-gates.mjs', 'verify');
  const status = tool('local-test-gates.mjs', 'status');
  expect(JSON.parse(status.slice(status.indexOf('{'))).accounts.find((a) => a.handle === who.handle)?.tiers).toContain(tier);
  await signOutBrowser(page.context());
}

/** One TEST market order on the real book, through the customer's own API: it fills against the market maker. */
async function trade(who, side) {
  const client = await api(who);
  const res = await client.post('/api/v1/orders', {
    symbol: SYMBOL,
    type: 'market',
    side,
    amount: TRADE,
    clientOrderId: `${J}-${side}-${Date.now()}`,
  });
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBeLessThan(300);
}

async function progressOf(who, campaignId) {
  const res = await (await api(who)).get(`/api/campaigns/trpc/tasks.progress?input=${encodeURIComponent(JSON.stringify({ campaignId }))}`);
  if (!res.body?.result) throw new Error(`tasks.progress refused (${res.status}): ${JSON.stringify(res.body).slice(0, 300)}`);
  return res.body.result.data;
}

/** Waits until the bus has carried the fills to svc-campaigns: steps count from events, never from this test. */
async function waitForProgress(who, campaignId, done) {
  await expect.poll(async () => (await progressOf(who, campaignId)).completed, { timeout: 30_000 }).toBe(done);
}

async function openCampaign(page, id) {
  await page.goto(`/campaigns/${encodeURIComponent(id)}`);
  await expect(page.getByTestId('campaign-detail')).toBeVisible();
  await expect(page.getByTestId('task-progress')).toBeVisible({ timeout: 30_000 });
}

test(`${J} #1 does the first step by a real trade: progress shows 1 of 3, and reading it again changes nothing`, async ({ page }) => {
  test.setTimeout(240_000);
  run.reset({});
  const me = person(`jc02me${tag}`.slice(0, 20));
  await signUpInBrowser(page, me);
  await signOutBrowser(page.context());
  // Basic verification is what trading needs; the campaign's claim needs full, which comes in #3.
  await verifyAs(page, me, 'Basic', 'basic');
  expect(fund(me.email, 'USDT', '500').tx).toBeTruthy();
  expect(fund(me.email, 'BTC', '0.01').tx).toBeTruthy();
  const campaign = await liveCampaign(`TEST three steps ${tag}`, THREE_STEPS);
  run.write({ me, campaignId: campaign.id });

  await signIn(page, me);
  await openCampaign(page, campaign.id);
  await expect(page.getByTestId('task-progress')).toHaveText('Join this campaign to start counting your steps.');
  await page.getByRole('button', { name: `Join ${campaign.name}` }).click();
  await expect(page.getByTestId('campaign-joined')).toBeVisible();
  await expect(page.getByTestId('task-progress')).toHaveText('0 of 3 steps done');
  await expect(page.getByTestId('task-gate')).toHaveText('Full verification');

  await trade(me, 'buy');
  await waitForProgress(me, campaign.id, 1);
  await page.reload();
  await expect(page.getByTestId('task-progress')).toHaveText('1 of 3 steps done');
  const steps = page.getByTestId('task-step');
  await expect(steps.nth(0)).toHaveAttribute('data-complete', 'true');
  await expect(steps.nth(1)).toHaveAttribute('data-complete', 'false');
  await expect(steps.nth(2)).toContainText('1 of 3');
  // Read again: the same fill is counted once.
  await page.reload();
  await expect(page.getByTestId('task-progress')).toHaveText('1 of 3 steps done');
  await expect(steps.nth(2)).toContainText('1 of 3');
});

test(`${J} #2 finishes the last step and claims before full verification: a typed refusal, nothing stored`, async ({ page }) => {
  test.setTimeout(120_000);
  const { me, campaignId } = state('me', 'campaignId');
  await trade(me, 'sell');
  await trade(me, 'buy');
  await waitForProgress(me, campaignId, 3);
  await signIn(page, me);
  await openCampaign(page, campaignId);
  await expect(page.getByTestId('task-progress')).toHaveText('3 of 3 steps done');
  await expect(page.getByTestId('task-claim-by')).toBeVisible();
  await page.getByRole('button', { name: 'Claim the reward' }).click();
  const refusal = page.getByTestId('task-refusal');
  await expect(refusal).toHaveAttribute('data-code', 'campaigns.kyc_required');
  await expect(refusal).toContainText('This reward needs Full verification before it can be claimed');
  // Nothing was written: no reward, and the claim stays open.
  expect((await progressOf(me, campaignId)).reward).toBeNull();
  await page.reload();
  await expect(page.getByTestId('task-reward-none')).toBeVisible();
});

test(`${J} #3 claims inside the window: one reward intent, "qualified" while the pot is empty, then "posted" with its transaction`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const { me, campaignId } = state('me', 'campaignId');
  await verifyAs(page, me, 'Full', 'full');
  await signIn(page, me);
  await openCampaign(page, campaignId);
  await page.getByRole('button', { name: 'Claim the reward' }).click();
  const reward = page.getByTestId('task-reward');
  await expect(reward).toBeVisible();
  // The pot holds no TEST USDT for this reward yet unless an earlier run funded it: qualified and still open, or posted.
  const first = await progressOf(me, campaignId);
  expect(['pending_funding', 'posted']).toContain(first.reward.state);
  if (first.reward.state === 'pending_funding') {
    await expect(page.getByTestId('task-reward-state')).toHaveText('Qualified: still open, waiting for the reward pot to be funded');
  }
  // Founders fund the pot from trade fees the platform earned; the reconciler pays the same key.
  await fundPot(`TEST-${J}-${tag}`, REWARD);
  await expect.poll(async () => (await progressOf(me, campaignId)).reward.state, { timeout: 60_000 }).toBe('posted');
  await page.reload();
  await expect(page.getByTestId('task-reward-state')).toHaveText('Posted to your account');
  await expect(page.getByTestId('task-reward-amount')).toHaveText(`${REWARD} USDT`);
  const posted = (await progressOf(me, campaignId)).reward;
  await expect(page.getByTestId('task-reward-tx')).toHaveAttribute('data-tx', posted.ledgerTxId);
  await expect(page.getByRole('link', { name: 'See it in your ledger history' })).toBeVisible();
  run.write({ rewardKey: posted.rewardKey, ledgerTxId: posted.ledgerTxId });
});

test(`${J} #4 claims again and loses the reply: the same reward, the screen re-reads instead of repeating`, async ({ page }) => {
  const { me, campaignId, rewardKey, ledgerTxId } = state('me', 'campaignId', 'rewardKey', 'ledgerTxId');
  // A second claim through the API returns the first reward: nothing new is created or paid.
  const res = await (await api(me)).post('/api/campaigns/trpc/tasks.claim', { campaignId });
  const again = res.body?.result?.data;
  expect(again, JSON.stringify(res.body).slice(0, 300)).toBeTruthy();
  expect(again.created).toBe(false);
  expect(again.reward.rewardKey).toBe(rewardKey);
  expect(again.reward.ledgerTxId).toBe(ledgerTxId);
  // On screen the reward is read back, and there is no second Claim to press.
  await signIn(page, me);
  await openCampaign(page, campaignId);
  await expect(page.getByTestId('task-reward')).toHaveAttribute('data-reward-key', rewardKey);
  await expect(page.getByRole('button', { name: 'Claim the reward' })).toHaveCount(0);
  const log = (await progressOf(me, campaignId)).reward.attempts.filter((a) => a.outcome === 'posted');
  expect(log).toHaveLength(1);
});

test(`${J} #5 claims after the window closed: the claim-expired state, and the reward is forfeited`, async ({ page }) => {
  test.setTimeout(180_000);
  const { me } = state('me');
  const short = await liveCampaign(`TEST short window ${tag}`, {
    steps: [{ title: 'TEST trade once', event: 'trade.fill', market: SYMBOL, side: null, count: 1 }],
    claimWindowSeconds: 20,
    kycGate: 'full',
  });
  await signIn(page, me);
  await openCampaign(page, short.id);
  await page.getByRole('button', { name: `Join ${short.name}` }).click();
  await expect(page.getByTestId('campaign-joined')).toBeVisible();
  await trade(me, 'buy');
  await waitForProgress(me, short.id, 1);
  const closes = new Date((await progressOf(me, short.id)).claimClosesAt).getTime();
  await page.waitForTimeout(Math.max(0, closes - Date.now()) + 2_000);
  await page.reload();
  await expect(page.getByTestId('task-progress')).toHaveText('1 of 1 steps done');
  await page.getByRole('button', { name: 'Claim the reward' }).click();
  await expect(page.getByTestId('task-refusal')).toHaveAttribute('data-code', 'campaigns.claim_expired');
  await page.reload();
  await expect(page.getByTestId('task-reward')).toHaveAttribute('data-state', 'forfeited');
  await expect(page.getByTestId('task-reward-state')).toHaveText('Forfeited: claimed after the claim window closed');
});

test(`${J} #6 opens the ledger history: the reward credited once, matching the reward record`, async ({ page }) => {
  const { me, ledgerTxId } = state('me', 'ledgerTxId');
  await openDesk(page, me, SYMBOL);
  await page.mouse.move(0, 600);
  await page.getByRole('tab', { name: 'Ledger' }).click();
  const table = page.getByRole('table', { name: 'Ledger history' });
  await expect(table).toBeVisible({ timeout: 30_000 });
  const rows = table.locator('tbody tr', { hasText: ledgerTxId });
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Campaign reward');
  await expect(rows.first()).toContainText('USDT');
  await expect(rows.first()).toContainText(`+${REWARD}`);
});

test(`${J} #7 opens the reward's redemption log: the outcome, any failure reason and the rollback window`, async ({ page }) => {
  const { me, campaignId } = state('me', 'campaignId');
  await signIn(page, me);
  await openCampaign(page, campaignId);
  const log = page.getByRole('region', { name: 'Redemption log' });
  await expect(log).toBeVisible();
  await expect(log.locator('[data-testid="redemption-attempt"][data-outcome="qualified"]')).toHaveCount(1);
  await expect(log.locator('[data-testid="redemption-attempt"][data-outcome="posted"]')).toHaveCount(1);
  // A refusal while the pot was empty names its reason.
  const refused = log.locator('[data-testid="redemption-attempt"][data-outcome="refused"]');
  if ((await refused.count()) > 0) await expect(refused.first().getByTestId('redemption-reason')).toHaveText('ledger.insufficient_funds');
  const rollback = page.getByTestId('task-rollback');
  await expect(rollback).toHaveAttribute('data-code', 'campaigns.reclaim_unavailable');
  await expect(rollback).toContainText('1 day after it was posted, until');
  await expect(rollback).toContainText('A rollback cannot be made yet');
});

test(`${J} #8 misses a day in a streak task: the streak resets at the zone boundary`, async () => {
  // Streak tasks (daily windows in the platform time zone, a reset on a missed day) are CM-tasks-quests-01's second
  // row and are not built yet; this step refuses at once so the run stays short.
  throw new Error(`${J} #8 is not built yet: streak tasks (CM-tasks-quests-01, campaigns-tasks-quests-002)`);
});
