import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
  // TEST limits (CM-eligibility-rules-03), wide enough that only a step about limits meets them.
  limits: { perCustomer: { count: 100, periodSeconds: 86_400 }, totalRedemptions: null },
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
  holdSeconds: 0,
  kycGate: 'full',
};

async function liveCampaign(name, tasks, over = {}) {
  const { ctx, pair } = await operators();
  const a = await pair.a.campaignsOpsToken();
  const b = await pair.b.campaignsOpsToken();
  const made = data(await ctx.edge.mutate('campaigns', 'ops.campaigns.create', definition(name, tasks, over), a), 'ops.campaigns.create');
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

/**
 * The same fill event delivered to svc-campaigns twice more: the customer's newest trade.fill.settled on the stack's bus,
 * published again with its payload unchanged (same fill id) under new envelope keys, so the bus does not drop it as its
 * own duplicate and the campaign's consumer is what must hold. Returns the payload.
 */
function redeliverFill(userId) {
  const code = `
    import { connect } from 'nats';
    import { EVENT_CATALOG, JetStreamEventBus, decodeEnvelope, streamName } from '@intafaced/events';
    const { NATS_URL: servers, NATS_STREAM_PREFIX: prefix, USER_ID: userId } = process.env;
    const subject = EVENT_CATALOG.fillSettled.subject;
    const nc = await connect({ servers });
    const jsm = await nc.jetstreamManager();
    const stream = streamName(EVENT_CATALOG.fillSettled.service, prefix);
    const { state } = await jsm.streams.info(stream);
    let payload;
    for (let seq = state.last_seq; seq >= state.first_seq && !payload; seq -= 1) {
      const m = await jsm.streams.getMessage(stream, { seq }).catch(() => null);
      if (m?.subject !== subject) continue;
      const env = decodeEnvelope(m.data);
      if (env.payload.userId === userId) payload = env.payload;
    }
    await nc.close();
    if (!payload) throw new Error('no ' + subject + ' for ' + userId + ' in ' + stream);
    const bus = await JetStreamEventBus.connect({ servers, producer: 'svc-trade', streamPrefix: prefix });
    for (const n of [1, 2]) {
      await bus.publish('fillSettled', payload, { idempotencyKey: payload.fillId + ':again:' + n + ':' + Date.now() });
    }
    await bus.close();
    console.log(JSON.stringify(payload));`;
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: path.join(root, 'packages', 'events'),
    env: { ...process.env, NATS_URL: 'nats://127.0.0.1:14232', NATS_STREAM_PREFIX: 'LOCAL_TEST', USER_ID: userId },
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (r.status !== 0) throw new Error(`delivering the fill event again failed: ${(r.stderr || r.stdout).slice(0, 500)}`);
  return JSON.parse(r.stdout.trim().split('\n').at(-1));
}

const FILL_STREAM = 'LOCAL_TEST_TRADE';

/** Until svc-campaigns' task fill consumer has taken and acknowledged every message on the bus. */
async function fillConsumerCaughtUp() {
  await expect(async () => {
    const info = await fetch('http://127.0.0.1:18232/jsz?consumers=true').then((r) => r.json());
    const consumer = info.account_details
      ?.flatMap((a) => a.stream_detail ?? [])
      .filter((st) => st.name === FILL_STREAM)
      .flatMap((st) => st.consumer_detail ?? [])
      .find((c) => c.name === 'campaigns-task-fill-settled');
    expect(consumer?.num_pending ?? -1).toBe(0);
    expect(consumer?.num_ack_pending ?? -1).toBe(0);
  }).toPass({ timeout: 30_000 });
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
  // The same fill event reaches svc-campaigns twice more on the bus: it is counted once.
  const fill = redeliverFill((await api(me)).userId);
  expect(fill).toMatchObject({ side: 'buy' });
  await fillConsumerCaughtUp();
  expect((await progressOf(me, campaign.id)).steps.map((s) => s.done)).toEqual([1, 0, 1]);
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
    holdSeconds: 0,
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
  // Credited once across the whole history: this account was opened for this journey, its whole history fits on the
  // tab's first page (50 lines), and its only reward is this one, so a second credit under any other transaction
  // would be a second 'Campaign reward' row.
  expect(await table.locator('tbody tr').count()).toBeLessThan(50);
  await expect(table.locator('tbody tr', { hasText: 'Campaign reward' })).toHaveCount(1);
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
  await expect(rollback).toContainText('No rollback can be made');
});

test(`${J} #8 misses a day in a streak task: the streak resets at the zone boundary`, async ({ page }) => {
  test.setTimeout(240_000);
  const { me } = state('me');
  // A streak step: trade on three days in a row, days read in the platform time zone (the stack's TEST zone is UTC).
  const streak = await liveCampaign(
    `TEST streak ${tag}`,
    {
      steps: [{ title: 'TEST trade three days in a row', event: 'trade.fill', market: SYMBOL, side: null, count: 1, streakDays: 3 }],
      claimWindowSeconds: 3600,
      holdSeconds: 0,
      kycGate: 'full',
    },
    { startsAt: new Date(Date.now() - 7 * DAY).toISOString() },
  );
  await signIn(page, me);
  await openCampaign(page, streak.id);
  await page.getByRole('button', { name: `Join ${streak.name}` }).click();
  await expect(page.getByTestId('campaign-joined')).toBeVisible();
  await trade(me, 'buy');
  await expect.poll(async () => (await progressOf(me, streak.id)).steps[0].streak.days, { timeout: 30_000 }).toBe(1);
  await page.reload();
  const run1 = page.getByTestId('task-streak');
  await expect(page.getByTestId('task-step').first()).toContainText('1 of 3 days in a row');
  await expect(run1).toHaveAttribute('data-reset', 'false');
  await expect(run1).toContainText('Your streak resets at');
  // The boundary is midnight in the platform time zone (UTC on this stack) after the next day: a run whose last day is
  // D lives through D+1 and resets at D+2 00:00.
  const midnightAfter = (day, n) => new Date(Date.parse(`${day}T00:00:00.000Z`) + n * DAY).toISOString();
  const today = (await progressOf(me, streak.id)).steps[0].streak;
  // The trade's day: today, or yesterday if UTC midnight passed since the trade.
  expect([new Date().toISOString().slice(0, 10), new Date(Date.now() - DAY).toISOString().slice(0, 10)]).toContain(today.lastDay);
  expect(today.resetsAt).toBe(midnightAfter(today.lastDay, 2));

  // One side of the boundary (LOCAL TEST fixture): that trading day becomes yesterday, so today is still inside the run
  // and its reset moves to tomorrow's midnight.
  expect(tool('local-test-stack.mjs', 'age-task-progress', me.email, streak.id, '1')).toContain('1 join(s) and 1 counted event(s)');
  const yesterday = (await progressOf(me, streak.id)).steps[0].streak;
  expect(yesterday).toMatchObject({ days: 1, reset: false, lastDay: midnightAfter(today.lastDay, -1).slice(0, 10) });
  expect(yesterday.resetsAt).toBe(midnightAfter(today.lastDay, 1));
  expect(Date.parse(yesterday.resetsAt)).toBeGreaterThan(Date.now());

  // The other side: one day more makes it two days ago, so yesterday was missed and the run ended at last midnight.
  expect(tool('local-test-stack.mjs', 'age-task-progress', me.email, streak.id, '1')).toContain('1 join(s) and 1 counted event(s)');
  await page.reload();
  const reset = page.getByTestId('task-streak');
  await expect(reset).toHaveAttribute('data-reset', 'true');
  await expect(reset).toHaveAttribute('data-days', '0');
  await expect(reset).toHaveAttribute('data-best', '1');
  await expect(reset).toContainText('Streak reset');
  await expect(reset).toContainText('the run ended at midnight in the platform time zone (days in it: 1)');
  await expect(page.getByTestId('task-step').first()).toContainText('0 of 3 days in a row');
  const p = await progressOf(me, streak.id);
  expect(p.steps[0]).toMatchObject({ done: 0, complete: false, streak: { days: 0, best: 1, lastRun: 1, reset: true, resetsAt: null } });

  // Trading again starts a new run of one day; the claim stays closed until three days in a row are done.
  await trade(me, 'sell');
  await expect.poll(async () => (await progressOf(me, streak.id)).steps[0].streak.days, { timeout: 30_000 }).toBe(1);
  await page.reload();
  await expect(page.getByTestId('task-streak')).toHaveAttribute('data-reset', 'false');
  await page.getByRole('button', { name: 'Claim the reward' }).click();
  await expect(page.getByTestId('task-refusal')).toHaveAttribute('data-code', 'campaigns.tasks_incomplete');
});
