import { randomBytes } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { ADMIN, founderSignIn } from './admin.mjs';
import { signIn } from './desk.mjs';
import { api, fund, journeyState, signOutBrowser, signUpInBrowser, tool } from './stack.mjs';

// J-campaigns-03, in the running app (docs/roadmap/journeys.json): see what I have earned, what is on hold, and why.
// One test per step, titled "J-campaigns-03 #<n>", run in order. The customer's rewards come from this run's TEST task
// campaigns, made by the stack's two LOCAL TEST founders through svc-campaigns' operator doors (A creates and asks, B
// approves, A activates). Each campaign's one step completes only from svc-trade's settled fill on the bus: the customer
// really buys BTC/USDT against the stack's market maker. USDT rewards come from the one reward pot, which the founders fund
// from trade fees the platform earned. The BTC reward's pot is never funded here, so it stays still open. The hold times
// are this run's TEST campaign values; the reconciler interval is the stack's labelled TEST value
// (tooling/profiles/test-owner-values/campaigns.json). Steps #4-#6 (locked rewards and bonuses) are not built.
const J = 'J-campaigns-03';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const SYMBOL = 'BTC/USDT';
const TRADE = '0.001';
const REWARD = '0.01';
const BTC_REWARD = '0.00001';
const DAY = 86_400_000;

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

/** A TEST task campaign with one step (buy BTC/USDT once) and every field the activation gate needs. */
async function liveCampaign(name, { holdSeconds, asset = 'USDT', amount = REWARD, budget = '0.05' }) {
  const { ctx, pair } = await operators();
  const a = await pair.a.campaignsOpsToken();
  const b = await pair.b.campaignsOpsToken();
  const definition = {
    name,
    type: 'task',
    rules: `TEST rules for ${name}: buy BTC/USDT once, then claim. The reward is TEST ${asset}.`,
    startsAt: new Date(Date.now() - 60_000).toISOString(),
    endsAt: new Date(Date.now() + 14 * DAY).toISOString(),
    participation: { exclusions: [], regionScope: 'platform' },
    budget: { asset, limit: budget },
    reward: { asset, amount },
    tasks: {
      steps: [{ title: 'TEST buy BTC', event: 'trade.fill', market: SYMBOL, side: 'buy', count: 1 }],
      claimWindowSeconds: 3600,
      holdSeconds,
      kycGate: 'basic',
    },
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

/** Founder A asks to sweep earned trade fees into the USDT reward pot; founder B approves, which posts it. */
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

const person = (handle) => ({
  handle,
  email: `${handle}@local-test.invalid`,
  password: `TEST-${randomBytes(9).toString('base64url')}-9a`,
});

/** Asks for a verification level on /verification; the two TEST operators approve it (local-test-gates.mjs verify). */
async function verifyAs(page, who, level) {
  await signIn(page, who);
  await page.goto('/verification');
  await page.getByLabel('Level to request').selectOption({ label: level });
  await page.getByLabel('Country code').fill('DE');
  await page.getByRole('button', { name: 'Review request' }).click();
  await page.getByRole('button', { name: 'Submit this request' }).click();
  await expect(page.getByText('Your reviewed request')).toBeVisible();
  tool('local-test-gates.mjs', 'verify');
  await signOutBrowser(page.context());
}

const trpc = (procedure, input) => `/api/campaigns/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify(input))}`;

async function call(who, method, procedure, input) {
  const client = await api(who);
  const res = method === 'GET' ? await client.get(trpc(procedure, input)) : await client.post(`/api/campaigns/trpc/${procedure}`, input);
  if (!res.body?.result) throw new Error(`${procedure} refused (${res.status}): ${JSON.stringify(res.body).slice(0, 300)}`);
  return res.body.result.data;
}

const mine = (who) => call(who, 'GET', 'rewards.mine', {});
const progressOf = (who, campaignId) => call(who, 'GET', 'tasks.progress', { campaignId });

/** One TEST market buy on the real book, through the customer's own API: it fills against the market maker. */
async function buy(who) {
  const res = await (
    await api(who)
  ).post('/api/v1/orders', {
    symbol: SYMBOL,
    type: 'market',
    side: 'buy',
    amount: TRADE,
    clientOrderId: `${J}-buy-${Date.now()}`,
  });
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBeLessThan(300);
}

/** Joins every campaign, buys once, and waits until the bus has carried the fill to each: steps count from events only. */
async function completeAll(who, ids) {
  for (const campaignId of ids) await call(who, 'POST', 'participation.join', { campaignId });
  await buy(who);
  for (const campaignId of ids) {
    await expect.poll(async () => (await progressOf(who, campaignId)).completed, { timeout: 45_000 }).toBe(1);
  }
}

async function openHub(page) {
  await page.goto('/uc/promotion');
  const hub = page.getByTestId('rewards-hub');
  await expect(hub).toBeVisible();
  await expect(hub).not.toHaveAttribute('data-state', 'loading', { timeout: 30_000 });
  return hub;
}

const row = (hub, campaignId) => hub.locator(`[data-testid="reward-row"][data-campaign="${campaignId}"]`);

// ── The platform posting freeze, as the founders' freeze desk does it (A asks, B approves, A runs) ─────────────────────

const founders = { a: null, b: null };
async function founderPages(browser) {
  for (const key of ['a', 'b']) {
    if (founders[key]) continue;
    founders[key] = await (await browser.newContext()).newPage();
    await founderSignIn(founders[key], key);
    await founders[key].goto(`${ADMIN}/`, { waitUntil: 'load' });
  }
  return founders;
}

const freezeStep = (page, body) =>
  page.evaluate(async (payload) => {
    const session = await (await fetch('/api/session', { cache: 'no-store' })).json();
    const res = await fetch('/api/ledger-freeze', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-intafaced-csrf': session.csrf },
      body: JSON.stringify(payload),
    });
    return { status: res.status, body: await res.json() };
  }, body);

const decode = (text) => JSON.parse(Buffer.from(text.slice('ifa1.'.length), 'base64url').toString('utf8'));
const readFreeze = (page) => page.evaluate(async () => (await fetch('/api/ledger-freeze', { cache: 'no-store' })).json());

async function setPostingFreeze(browser, frozen) {
  const { a, b } = await founderPages(browser);
  const record = await readFreeze(a);
  expect(record.ok, JSON.stringify(record)).toBe(true);
  if (record.state.frozen === frozen) return;
  const version = record.state.version;
  const request = frozen
    ? { kind: 'ledger.freeze', reason: `LOCAL TEST ${J} #3 hold release ${tag}`, version }
    : { kind: 'ledger.unfreeze', version };
  const confirm = frozen ? 'FREEZE LEDGER' : 'UNFREEZE LEDGER';
  const proposed = await freezeStep(a, { step: 'propose', request, confirm });
  expect(proposed.body.ok, JSON.stringify(proposed.body)).toBe(true);
  const packet = decode(proposed.body.packet);
  const approved = await freezeStep(b, { step: 'approve', request, confirm, approvalId: packet.approvalId });
  expect(approved.body.ok, JSON.stringify(approved.body)).toBe(true);
  const ran = await freezeStep(a, { step: 'execute', request, confirm, approvalId: packet.approvalId, operationId: packet.operationId });
  expect(ran.body.ok, JSON.stringify(ran.body)).toBe(true);
  expect((await readFreeze(a)).state.frozen).toBe(frozen);
}

// ── Steps ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

test(`${J} #1 opens /uc/promotion with no activity: an honest empty state, no invented rows or totals`, async ({ page }) => {
  test.setTimeout(180_000);
  run.reset({});
  const me = person(`jc03me${tag}`.slice(0, 20));
  await signUpInBrowser(page, me);
  await signOutBrowser(page.context());
  // Basic is what trading needs; the account's activity, where a posted reward's link opens, needs Full.
  await verifyAs(page, me, 'Basic');
  await verifyAs(page, me, 'Full');
  expect(fund(me.email, 'USDT', '500').tx).toBeTruthy();
  run.write({ me });

  expect(await mine(me)).toEqual({ rewards: [], totals: [] });
  await signIn(page, me);
  const hub = await openHub(page);
  await expect(hub).toHaveAttribute('data-state', 'ready');
  await expect(hub.getByTestId('rewards-empty')).toContainText('No rewards so far');
  await expect(hub.getByTestId('rewards-totals')).toHaveCount(0);
  await expect(hub.getByTestId('reward-row')).toHaveCount(0);
  await expect(hub.getByRole('link', { name: 'Find a campaign' })).toHaveAttribute('href', '/campaigns');
});

test(`${J} #2 opens it with rewards in each state: earned, on hold and still open, each with its reason`, async ({ page }) => {
  test.setTimeout(300_000);
  const { me } = state('me');
  const posted = await liveCampaign(`TEST paid at once ${tag}`, { holdSeconds: 0 });
  const held = await liveCampaign(`TEST held for review ${tag}`, { holdSeconds: 3600 });
  // The BTC reward pot is never funded by this journey: its reward is qualified and waits, still open.
  const open = await liveCampaign(`TEST BTC reward ${tag}`, { holdSeconds: 0, asset: 'BTC', amount: BTC_REWARD, budget: '0.0001' });
  await completeAll(me, [posted.id, held.id, open.id]);
  await fundPot(`TEST-${J}-2-${tag}`, REWARD);
  for (const c of [posted, held, open]) await call(me, 'POST', 'tasks.claim', { campaignId: c.id });
  await expect.poll(async () => (await progressOf(me, posted.id)).reward.state, { timeout: 60_000 }).toBe('posted');
  expect((await progressOf(me, held.id)).reward.state).toBe('held');
  expect((await progressOf(me, open.id)).reward.state).toBe('pending_funding');

  await signIn(page, me);
  const hub = await openHub(page);
  const paid = row(hub, posted.id);
  await expect(paid).toHaveAttribute('data-status', 'posted');
  await expect(paid.getByTestId('reward-status')).toHaveText('Posted');
  await expect(paid.getByTestId('reward-amount')).toHaveText(`${REWARD} USDT`);
  const tx = (await progressOf(me, posted.id)).reward.ledgerTxId;
  await expect(paid.getByTestId('reward-tx')).toHaveAttribute('data-tx', tx);
  await expect(paid.getByTestId('reward-tx')).toHaveAttribute('href', `/money/activity/${encodeURIComponent(tx)}`);

  const waiting = row(hub, held.id);
  await expect(waiting).toHaveAttribute('data-status', 'on_hold');
  await expect(waiting.getByTestId('reward-status')).toHaveText('On hold');
  await expect(waiting.getByTestId('reward-why')).toContainText('Waiting for the campaign’s review hold to end:');
  await expect(waiting.getByTestId('reward-why')).toContainText(/(59|60) minutes left, until/);
  await expect(waiting.getByTestId('reward-tx')).toHaveCount(0);

  const still = row(hub, open.id);
  await expect(still).toHaveAttribute('data-status', 'still_open');
  await expect(still.getByTestId('reward-status')).toHaveText('Still open');
  await expect(still.getByTestId('reward-why')).toHaveAttribute('data-reason', 'ledger.insufficient_funds');
  await expect(still.getByTestId('reward-why')).toContainText('The reward pot cannot cover it at the moment');

  // Totals are summed from the rows: one per status and asset.
  const total = (status, asset) => hub.locator(`[data-testid="rewards-total"][data-status="${status}"][data-asset="${asset}"]`);
  await expect(total('posted', 'USDT').getByTestId('rewards-total-amount')).toHaveText(`${REWARD} USDT`);
  await expect(total('on_hold', 'USDT').getByTestId('rewards-total-amount')).toHaveText(`${REWARD} USDT`);
  await expect(total('still_open', 'BTC').getByTestId('rewards-total-amount')).toHaveText(`${BTC_REWARD} BTC`);
  await expect(hub.getByTestId('rewards-total')).toHaveCount(3);

  // The transaction link opens the posting in the account's activity.
  await paid.getByTestId('reward-tx').click();
  await expect(page).toHaveURL(new RegExp(`/money/activity/${tx}`));
  await expect(page.locator('main')).toContainText(REWARD, { timeout: 30_000 });
  run.write({ heldId: held.id, openId: open.id });
});

test(`${J} #3 watches a held reward when its hold ends under a posting freeze: still open, then posted once after it lifts`, async ({
  page,
  browser,
}) => {
  test.setTimeout(420_000);
  const { me } = state('me');
  const hold = await liveCampaign(`TEST short hold ${tag}`, { holdSeconds: 75 });
  await completeAll(me, [hold.id]);
  await fundPot(`TEST-${J}-3-${tag}`, REWARD);
  const claimed = await call(me, 'POST', 'tasks.claim', { campaignId: hold.id });
  expect(claimed.reward.state).toBe('held');
  const until = new Date(claimed.reward.holdUntil).getTime();
  try {
    await setPostingFreeze(browser, true);
    expect(Date.now(), 'the freeze must be on before the hold ends').toBeLessThan(until);
    // The hold ends with posting frozen: the reward is released once and its post refused, so it stays still open.
    await page.waitForTimeout(Math.max(0, until - Date.now()));
    await expect.poll(async () => (await progressOf(me, hold.id)).reward.state, { timeout: 60_000 }).toBe('pending_retry');
    await signIn(page, me);
    let hub = await openHub(page);
    await expect(row(hub, hold.id)).toHaveAttribute('data-status', 'still_open');
    await expect(row(hub, hold.id).getByTestId('reward-why')).toHaveAttribute('data-reason', 'ledger.frozen');
    await expect(row(hub, hold.id).getByTestId('reward-why')).toContainText('Payments are paused on the platform');
    // While frozen the reconciler keeps posting the same key and keeps being refused: nothing is paid.
    await page.waitForTimeout(12_000);
    expect((await progressOf(me, hold.id)).reward.state).toBe('pending_retry');

    await setPostingFreeze(browser, false);
    await expect.poll(async () => (await progressOf(me, hold.id)).reward.state, { timeout: 60_000 }).toBe('posted');
    hub = await openHub(page);
    await expect(row(hub, hold.id)).toHaveAttribute('data-status', 'posted');
    await expect(row(hub, hold.id).getByTestId('reward-tx')).toBeVisible();
  } finally {
    await setPostingFreeze(browser, false);
  }
  // Posted once: one released, one posted in the log, and later reconciler passes add nothing.
  await page.waitForTimeout(12_000);
  const reward = (await progressOf(me, hold.id)).reward;
  expect(reward.attempts.filter((a) => a.outcome === 'released')).toHaveLength(1);
  expect(reward.attempts.filter((a) => a.outcome === 'posted')).toHaveLength(1);
  expect(reward.attempts.filter((a) => a.outcome === 'refused').every((a) => a.reason === 'ledger.frozen')).toBe(true);
  const rows = (await mine(me)).rewards.filter((r) => r.campaignId === hold.id);
  expect(rows).toHaveLength(1);
  expect(rows[0].ledgerTxId).toBe(reward.ledgerTxId);
});

test(`${J} #7 opens the hub while the campaigns service is down: the error state, no stale number shown as current`, async ({ page }) => {
  test.setTimeout(240_000);
  const { me, heldId } = state('me', 'heldId');
  await signIn(page, me);
  let hub = await openHub(page);
  await expect(row(hub, heldId)).toBeVisible();
  try {
    tool('local-test-stack.mjs', 'stop', 'campaigns');
    hub = await openHub(page);
    await expect(hub).toHaveAttribute('data-state', 'failed');
    await expect(hub.getByTestId('rewards-failed')).toBeVisible();
    await expect(hub.getByTestId('rewards-totals')).toHaveCount(0);
    await expect(hub.getByTestId('reward-row')).toHaveCount(0);
    await expect(hub.getByTestId('rewards-empty')).toHaveCount(0);
  } finally {
    tool('local-test-stack.mjs', 'start', '--only', 'campaigns');
  }
  // Recovery: once it answers again, the hub reads the stored rewards afresh.
  await expect
    .poll(
      async () => {
        hub = await openHub(page);
        return hub.getAttribute('data-state');
      },
      { timeout: 90_000, intervals: [3_000] },
    )
    .toBe('ready');
  await expect(row(hub, heldId)).toHaveAttribute('data-status', 'on_hold');
});
