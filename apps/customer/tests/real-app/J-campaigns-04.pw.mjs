import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import { signIn, signUp, verify } from './desk.mjs';
import { api, fund, journeyState, signOutBrowser, tool } from './stack.mjs';

// J-campaigns-04, in the running app (docs/roadmap/journeys.json): finish the welcome checklist. One test per step, titled
// "J-campaigns-04 #<n>", run in order. The welcome campaigns are this run's TEST campaigns, made by the stack's two LOCAL
// TEST founders through svc-campaigns' operator doors (A creates and asks, B approves, A activates). A welcome window
// opens at each account's real sign-up (identity.user.created), and each task ticks only from its own real event:
// verification approved (identity.kyc.approved), a crypto deposit credited on the TEST chain (pay.deposit_credit.posted)
// and a spot fill against the stack's market maker (trade.fill.settled). Rewards are TEST USDT from the one reward pot,
// which the founders fund from trade fees the platform earned.
const J = 'J-campaigns-04';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const SHORT_WINDOW = 90;
const REWARDS = { 'identity.verified': '0.01', 'pay.deposit': '0.02', 'trade.fill': '0.03' };
const TITLES = { 'identity.verified': 'TEST verify your identity', 'pay.deposit': 'TEST first deposit', 'trade.fill': 'TEST first trade' };

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

/** A TEST welcome campaign, live now; `blank` leaves those tasks' rewards blank, `windowSeconds` is its welcome window. */
async function liveWelcome(name, { windowSeconds, blank = [] }) {
  const { ctx, pair } = await operators();
  const a = await pair.a.campaignsOpsToken();
  const b = await pair.b.campaignsOpsToken();
  const steps = Object.entries(TITLES).map(([event, title]) => ({
    title,
    event,
    count: 1,
    reward: blank.includes(event) ? null : { asset: 'USDT', amount: REWARDS[event] },
  }));
  const definition = {
    name,
    type: 'welcome',
    rules: `TEST rules for ${name}: verify, make a first crypto deposit and a first spot trade. Rewards are TEST USDT.`,
    startsAt: new Date(Date.now() - 60_000).toISOString(),
    endsAt: new Date(Date.now() + 14 * 86_400_000).toISOString(),
    participation: { exclusions: [], regionScope: 'platform' },
    budget: { asset: 'USDT', limit: '0.06' },
    tasks: { steps, claimWindowSeconds: null, holdSeconds: 0, kycGate: 'none', welcomeWindowSeconds: windowSeconds },
  };
  const made = data(await ctx.edge.mutate('campaigns', 'ops.campaigns.create', definition, a), 'ops.campaigns.create');
  data(await ctx.edge.mutate('campaigns', 'ops.campaigns.transition', { id: made.id, action: 'submit', revision: 1 }, a), 'submit');
  data(await ctx.edge.mutate('campaigns', 'ops.campaigns.transition', { id: made.id, action: 'approve', revision: 1 }, b), 'approve');
  const live = data(
    await ctx.edge.mutate('campaigns', 'ops.campaigns.transition', { id: made.id, action: 'activate', revision: 1 }, a),
    'activate',
  );
  expect(live.state).toBe('active');
  return live;
}

/** Founder A ends a welcome campaign: accounts that sign up after it get none from it. */
async function endCampaign(id) {
  const { ctx, pair } = await operators();
  const a = await pair.a.campaignsOpsToken();
  const ended = data(await ctx.edge.mutate('campaigns', 'ops.campaigns.transition', { id, action: 'end', revision: 1 }, a), 'end');
  expect(ended.state).toBe('ended');
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
  const funded = data(await ctx.edge.mutate('campaigns', 'ops.pot.approve', { reference }, b), 'ops.pot.approve');
  expect(funded.state, JSON.stringify(funded)).toBe('posted');
}

async function checklistOf(who) {
  const res = await (await api(who)).get(`/api/campaigns/trpc/tasks.welcome.list?input=${encodeURIComponent('{}')}`);
  if (!res.body?.result) throw new Error(`tasks.welcome.list refused (${res.status}): ${JSON.stringify(res.body).slice(0, 300)}`);
  return res.body.result.data;
}

const taskOf = (list, event) => list.tasks.find((t) => t.event === event);

/** Waits until svc-campaigns has read the sign-up from the bus and placed the account under this campaign. */
async function waitForChecklist(who, campaignId) {
  await expect.poll(async () => (await checklistOf(who)).campaign?.id ?? null, { timeout: 30_000 }).toBe(campaignId);
}

/** Waits until the bus has carried an event to svc-campaigns: tasks tick from events, never from this test. */
async function waitForTask(who, event, taskState) {
  await expect.poll(async () => taskOf(await checklistOf(who), event)?.state, { timeout: 60_000 }).toBe(taskState);
}

async function openChecklist(page, path = '/uc/promotion') {
  await page.goto(path);
  const list = page.getByTestId('welcome-checklist');
  await expect(list).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
  return list;
}

const row = (page, event) => page.locator(`[data-testid="welcome-task"][data-event="${event}"]`);

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

/**
 * The same deposit event delivered to svc-campaigns twice more: the customer's newest pay.deposit_credit.posted on the
 * stack's bus, published again with its payload unchanged (same deposit id) under new envelope keys, so the bus does not
 * drop it as its own duplicate and the welcome consumer is what must hold. Returns the payload.
 */
function redeliverDeposit(userId) {
  const code = `
    import { connect } from 'nats';
    import { EVENT_CATALOG, JetStreamEventBus, decodeEnvelope, streamName } from '@intafaced/events';
    const { NATS_URL: servers, NATS_STREAM_PREFIX: prefix, USER_ID: userId } = process.env;
    const subject = EVENT_CATALOG.payDepositCreditPosted.subject;
    const nc = await connect({ servers });
    const jsm = await nc.jetstreamManager();
    const stream = streamName('pay', prefix);
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
    const bus = await JetStreamEventBus.connect({ servers, producer: 'svc-pay', streamPrefix: prefix });
    for (const n of [1, 2]) {
      await bus.publish('payDepositCreditPosted', payload, { idempotencyKey: payload.depositId + ':welcome-again:' + n + ':' + Date.now() });
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
  if (r.status !== 0) throw new Error(`delivering the deposit event again failed: ${(r.stderr || r.stdout).slice(0, 500)}`);
  return JSON.parse(r.stdout.trim().split('\n').at(-1));
}

/** Until svc-campaigns' welcome deposit consumer has taken and acknowledged every message on the bus. */
async function depositConsumerCaughtUp() {
  await expect(async () => {
    const info = await fetch('http://127.0.0.1:18232/jsz?consumers=true').then((r) => r.json());
    const consumer = info.account_details
      ?.flatMap((a) => a.stream_detail ?? [])
      .flatMap((st) => st.consumer_detail ?? [])
      .find((c) => c.name === 'campaigns-welcome-deposit-credited');
    expect(consumer?.num_pending ?? -1).toBe(0);
    expect(consumer?.num_ack_pending ?? -1).toBe(0);
  }).toPass({ timeout: 30_000 });
}

test(`${J} #1 opens /uc/promotion on a new account: the checklist with its time window, and a blank reward reads "not set"`, async ({
  browser,
}) => {
  test.setTimeout(240_000);
  run.reset({});
  // A short-window campaign with the deposit reward blank: the account that signs up under it returns in #5.
  const short = await liveWelcome(`TEST welcome short ${tag}`, { windowSeconds: SHORT_WINDOW, blank: ['pay.deposit'] });
  const page = await (await browser.newContext()).newPage();
  const early = await signUp(page, 'jc04x');
  await waitForChecklist(early, short.id);
  const list = await openChecklist(page, '/uc/promotion');
  await expect(list.getByTestId('welcome-campaign')).toHaveText(short.name);
  const window = list.getByTestId('welcome-window');
  await expect(window).toHaveAttribute('data-state', 'open');
  await expect(window).toContainText('Your welcome window: From');
  const shown = await checklistOf(early);
  expect(new Date(shown.window.closesAt).getTime() - new Date(shown.window.opensAt).getTime()).toBe(SHORT_WINDOW * 1000);
  await expect(page.getByTestId('welcome-task')).toHaveCount(3);
  await expect(row(page, 'pay.deposit').getByTestId('welcome-reward')).toHaveText('not set');
  await expect(row(page, 'identity.verified').getByTestId('welcome-reward')).toHaveText('0.01 USDT');
  for (const event of Object.keys(TITLES)) await expect(row(page, event)).toHaveAttribute('data-state', 'open');
  await signOutBrowser(page.context());

  // The main account signs up under the full campaign, with every reward set and a week's window.
  await endCampaign(short.id);
  const full = await liveWelcome(`TEST welcome ${tag}`, { windowSeconds: 7 * 86_400 });
  const me = await signUp(page, 'jc04me');
  await waitForChecklist(me, full.id);
  const mine = await openChecklist(page);
  await expect(mine.getByTestId('welcome-campaign')).toHaveText(full.name);
  await expect(mine.getByTestId('welcome-window')).toHaveAttribute('data-state', 'open');
  await expect(row(page, 'pay.deposit').getByTestId('welcome-reward')).toHaveText('0.02 USDT');
  run.write({ early, me, shortId: short.id, fullId: full.id });
});

test(`${J} #2 verifies and deposits TEST funds: the matching tasks tick once, and a redelivered event changes nothing`, async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const { me } = state('me', 'fullId');
  const page = await (await browser.newContext()).newPage();
  await signIn(page, me);
  await verify(page, me, 'Basic');
  await waitForTask(me, 'identity.verified', 'done');
  await signIn(page, me);
  const address = await depositAddress(page);
  expect(tool('local-test-stack.mjs', 'chain-deposit', address, 'USDT', '20', '6', '--tx', `jc04-${me.handle}`)).toContain(
    '"received":true',
  );
  await waitForTask(me, 'pay.deposit', 'done');
  const before = await checklistOf(me);
  await openChecklist(page);
  await expect(row(page, 'identity.verified')).toHaveAttribute('data-state', 'done');
  await expect(row(page, 'pay.deposit')).toHaveAttribute('data-state', 'done');
  await expect(row(page, 'trade.fill')).toHaveAttribute('data-state', 'open');
  await expect(row(page, 'pay.deposit').getByTestId('welcome-why')).toContainText('Done on');

  // The same deposit event reaches svc-campaigns twice more: the task stays ticked once, at the same moment.
  const customer = await api(me);
  expect(redeliverDeposit(customer.userId)).toMatchObject({ userId: customer.userId, assetId: 'USDT', amount: '20' });
  await depositConsumerCaughtUp();
  const after = await checklistOf(me);
  expect(taskOf(after, 'pay.deposit')).toEqual(taskOf(before, 'pay.deposit'));
  expect(taskOf(after, 'identity.verified')).toEqual(taskOf(before, 'identity.verified'));
  await page.reload();
  await expect(page.getByTestId('welcome-task')).toHaveCount(3);
  await expect(row(page, 'pay.deposit')).toHaveAttribute('data-state', 'done');
});

test(`${J} #3 deposits using bonus money: the deposit task does not tick`, async ({ browser }) => {
  test.setTimeout(240_000);
  const { fullId } = state('fullId');
  const page = await (await browser.newContext()).newPage();
  const other = await signUp(page, 'jc04z');
  await waitForChecklist(other, fullId);
  // Money that is not the customer's own deposit: the stack's labelled TEST funds credit (a trial fund through the real
  // ledger). It lands in the balance and is no crypto deposit, so svc-pay never says a deposit was credited.
  const credit = fund(other.email, 'USDT', '50');
  expect(credit.tx).toBeTruthy();
  await depositConsumerCaughtUp();
  expect(taskOf(await checklistOf(other), 'pay.deposit')).toMatchObject({ state: 'open', doneAt: null });
  await openChecklist(page);
  await expect(row(page, 'pay.deposit')).toHaveAttribute('data-state', 'open');
  await expect(row(page, 'pay.deposit').getByTestId('welcome-why')).toContainText(
    'Credits from a bonus, a trial fund or a gift do not count',
  );
  // Asking to claim it anyway is refused by name, and nothing is written.
  const res = await (await api(other)).post('/api/campaigns/trpc/tasks.welcome.claim', { event: 'pay.deposit' });
  expect(res.body?.error?.message ?? '').toContain('[campaigns.tasks_incomplete]');
  expect(taskOf(await checklistOf(other), 'pay.deposit').record).toBeNull();
});

test(`${J} #4 claims after all tasks are done: one reward per task, each once`, async ({ browser }) => {
  test.setTimeout(300_000);
  const { me, fullId } = state('me', 'fullId');
  // The last task by a real trade: a market buy on the real book, filled against the market maker.
  expect(fund(me.email, 'USDT', '500').tx).toBeTruthy();
  const client = await api(me);
  const order = await client.post('/api/v1/orders', {
    symbol: 'BTC/USDT',
    type: 'market',
    side: 'buy',
    amount: '0.001',
    clientOrderId: `${J}-buy-${Date.now()}`,
  });
  expect(order.status, JSON.stringify(order.body).slice(0, 300)).toBeLessThan(300);
  await waitForTask(me, 'trade.fill', 'done');
  await fundPot(`TEST-${J}-${tag}`, '0.06');

  const page = await (await browser.newContext()).newPage();
  await signIn(page, me);
  await openChecklist(page);
  for (const [event, title] of Object.entries(TITLES)) {
    await page.getByRole('button', { name: `Claim the reward for ${title}` }).click();
    await expect(row(page, event)).toHaveAttribute('data-state', 'claimed');
  }
  await expect
    .poll(async () => (await checklistOf(me)).tasks.map((t) => t.record?.state), { timeout: 60_000 })
    .toEqual(['posted', 'posted', 'posted']);
  const claimed = await checklistOf(me);
  for (const t of claimed.tasks) {
    expect(t.record.rewardKey).toBe(`task:${fullId}:${client.userId.toLowerCase()}:welcome:${t.event}`);
    expect(t.record.amount).toBe(REWARDS[t.event]);
    // A second claim returns the first: nothing new is created or paid.
    const again = await client.post('/api/campaigns/trpc/tasks.welcome.claim', { event: t.event });
    expect(again.body?.result?.data, JSON.stringify(again.body).slice(0, 300)).toMatchObject({
      created: false,
      reward: { rewardKey: t.record.rewardKey, ledgerTxId: t.record.ledgerTxId },
    });
  }
  await page.reload();
  for (const event of Object.keys(TITLES)) {
    await expect(row(page, event)).toHaveAttribute('data-state', 'claimed');
    await expect(row(page, event).getByTestId('welcome-tx')).toBeVisible();
  }
  await expect(page.getByRole('button', { name: /^Claim the reward for/ })).toHaveCount(0);
  // My rewards lists exactly the three, each once.
  await page.goto('/uc/promotion');
  const rows = page.locator(`[data-testid="reward-row"][data-campaign="${fullId}"]`);
  await expect(rows).toHaveCount(3, { timeout: 30_000 });
  await expect(rows.filter({ has: page.locator('[data-testid="reward-status"]', { hasText: 'Posted' }) })).toHaveCount(3);
});

test(`${J} #5 returns after the window: the tasks read expired and no reward is created`, async ({ browser }) => {
  test.setTimeout(240_000);
  const { early, shortId, fullId } = state('early', 'shortId', 'fullId');
  const opened = await checklistOf(early);
  expect(opened.campaign.id).toBe(shortId);
  const wait = new Date(opened.window.closesAt).getTime() - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait + 1_000));
  const page = await (await browser.newContext()).newPage();
  await signIn(page, early);
  // A real event after the window ticks nothing: the account verifies now.
  await verify(page, early, 'Basic');
  await signIn(page, early);
  const list = await openChecklist(page);
  await expect(list.getByTestId('welcome-window')).toHaveAttribute('data-state', 'expired');
  for (const event of Object.keys(TITLES)) {
    await expect(row(page, event)).toHaveAttribute('data-state', 'expired');
    await expect(row(page, event).getByTestId('welcome-why')).toHaveText(
      'The welcome window closed before this task was claimed. No reward is given.',
    );
  }
  await expect(page.getByRole('button', { name: /^Claim the reward for/ })).toHaveCount(0);
  const res = await (await api(early)).post('/api/campaigns/trpc/tasks.welcome.claim', { event: 'identity.verified' });
  expect(res.body?.error?.message ?? '').toContain('[campaigns.claim_expired]');
  const mine = await (await api(early)).get(`/api/campaigns/trpc/rewards.mine?input=${encodeURIComponent('{}')}`);
  expect(mine.body?.result?.data?.rewards ?? null).toEqual([]);
  // The run leaves no welcome campaign running for later sign-ups.
  await endCampaign(fullId);
});
