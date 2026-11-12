// World: book, restart, freeze
import { randomBytes } from 'node:crypto';
import { test, expect } from './journey.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';
import { signIn } from './desk.mjs';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { api, fund, journeyState, signOutBrowser, signUpInBrowser, tool } from './stack.mjs';
import { otherTraderKey, otherTraderRun, testDeposit, testVenue, venueForThisFile, venueRecord } from './venue.mjs';

// J-campaigns-03, in the running app (docs/roadmap/journeys.json): see what I have earned, what is on hold, and why.
// One test per step, titled "J-campaigns-03 #<n>", run in order. The launch money model (OWNER 226, OWNER 288): a reward
// is owed by INTAFACED and paid in USDC to the customer's own connected wallet; it is never credited to a balance. The
// customer's rewards come from this run's TEST task campaigns, made by the stack's two LOCAL TEST founders through
// svc-campaigns' operator doors (A creates and asks, B approves, A activates). Each campaign's one step completes only from
// svc-trade's settled fill on the bus: the customer buys BTC/USDT against the stack's market maker. The USDC reward pot is
// funded by the founders from builder fees the TEST venue credited us on this file's own routed sells (the venue door is
// on for this file). The hold times, the lock and the TEST reward ceiling are this run's TEST values
// (tooling/profiles/test-owner-values/campaigns.json). #6 is Later (OWNER 226: a bonus we hold) and is not here.
const J = 'J-campaigns-03';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const SYMBOL = 'BTC/USDT';
const TRADE = '0.001';
const ASSET = 'USDC';
const REWARD = '0.01';
// Past the stack's TEST per-campaign ceiling (100 USDC): INTAFACED may not owe it, so it stays still open, retried.
const OVER_CEILING = '101';
const DAY = 86_400_000;
const RUN = process.env.JOURNEY_RUN_ID ?? 'local';

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
async function liveCampaign(name, { holdSeconds, asset = ASSET, amount = REWARD, budget = '0.05', lock = null }) {
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
    // TEST limits (CM-eligibility-rules-03), wide enough that only a step about limits meets them.
    limits: { perCustomer: { count: 100, periodSeconds: 86_400 }, totalRedemptions: null },
    reward: { asset, amount },
    tasks: {
      steps: [{ title: 'TEST buy BTC', event: 'trade.fill', market: SYMBOL, side: 'buy', count: 1 }],
      claimWindowSeconds: 3600,
      holdSeconds,
      lock,
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

/** Founder A asks to sweep earned builder fees into the USDC reward pot; founder B approves, which posts it. */
async function fundPot(reference, amount) {
  const { ctx, pair } = await operators();
  const a = await pair.a.campaignsOpsToken();
  const b = await pair.b.campaignsOpsToken();
  data(
    await ctx.edge.mutate('campaigns', 'ops.pot.request', { reference, sourceModule: 'builder', asset: ASSET, amount }, a),
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
const total = (hub, status) => hub.locator(`[data-testid="rewards-total"][data-status="${status}"][data-asset="${ASSET}"]`);

// ── Builder fees to fund the pot: a TEST trader of this file sells through our venue door into a TEST bid ─────────────

venueForThisFile(test);
const traderKey = privateKeyToAccount(keccak256(toHex(`intafaced TEST venue journey trader ${J} ${RUN}`)));
const traderOwner = traderKey.address.toLowerCase();

/** One action through svc-trade's user-venue door as `who`: prepare, sign with the TEST key, submit. */
async function door(who, intent, actionKey) {
  const session = await api(who);
  const signer = { role: 'owner', address: traderOwner };
  const prepared = await session.post('/api/v1/venue/prepare', { owner: traderOwner, signer, intent, ...(actionKey ? { actionKey } : {}) });
  expect(prepared.status, JSON.stringify(prepared.body).slice(0, 400)).toBe(200);
  const p = prepared.body.prepared;
  const t = p.typedData;
  const signature = await traderKey.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
  const sent = await session.post('/api/v1/venue/submit', {
    actionKey: prepared.body.actionKey,
    signature: { digest: p.digest, signature, signedBy: traderOwner },
  });
  expect(sent.status, JSON.stringify(sent.body).slice(0, 400)).toBe(200);
  expect(sent.body.outcome, JSON.stringify(sent.body.outcome).slice(0, 400)).toMatchObject({ definite: true, accepted: true });
  return sent.body;
}

/** Adds decimal strings exactly (no float). */
function sumDecimal(values) {
  const scale = 18;
  const units = (x) => {
    const [w, f = ''] = String(x).split('.');
    return BigInt(w + f.padEnd(scale, '0'));
  };
  const sum = values
    .reduce((n, v) => n + units(v), 0n)
    .toString()
    .padStart(scale + 1, '0');
  const frac = sum.slice(-scale).replace(/0+$/, '');
  return frac ? `${sum.slice(0, -scale)}.${frac}` : sum.slice(0, -scale);
}

/**
 * Builder fees the TEST venue credits us on this file's own sells: `who` approves our builder fee, sells 0.01 BTC into
 * a TEST bid `sells` times, and the venue's own fills say what each earned us. Returns their sum, the amount the pot may
 * be funded with once svc-trade has posted them.
 */
let orders = 0;
async function earnBuilderFees(who, sells) {
  const since = new Date(Date.now() - 1000);
  const account = { venueId: (await testVenue('/venue')).body.venue.id, owner: traderOwner, subAccount: null };
  for (const [asset, amount] of [
    ['USDC', '10000'],
    ['BTC', '1'],
  ]) {
    const ref = `84532:${keccak256(toHex(`${J} ${RUN} ${traderOwner} ${asset}`))}:0`;
    const funded = await testVenue('/test/deposit', { account, asset, amount, depositRef: ref });
    expect(funded.status, JSON.stringify(funded.body)).toBe(200);
  }
  const status = (await (await api(who)).get('/api/v1/venue/status')).body;
  expect(status, JSON.stringify(status).slice(0, 300)).toMatchObject({ enabled: true, test: true });
  const markets = await testVenue('/markets', { account: null });
  const cap = markets.body.value.find((m) => m.symbol === 'BTC-USDC').builderFeeCapBps.value;
  await door(who, { kind: 'approve_builder_fee', builder: status.builder.address, maxFeeBps: cap }, `approve-builder:${traderOwner}:${J}`);
  const buyer = `${J}-buyer-${RUN}`;
  await testDeposit(otherTraderKey(buyer).address, 'USDC', '10000', `seed:${buyer}:USDC`);
  const bid = await otherTraderRun(buyer, {
    kind: 'place_order',
    symbol: 'BTC-USDC',
    side: 'buy',
    type: 'limit',
    amount: String(0.01 * sells),
    price: '59990',
    timeInForce: 'GTC',
    reduceOnly: false,
    clientOrderKey: `order:${buyer}:bid:${Date.now()}`,
    builderFee: null,
  });
  expect(bid, JSON.stringify(bid).slice(0, 300)).toMatchObject({ definite: true, accepted: true });
  for (let i = 0; i < sells; i += 1) {
    await door(who, {
      kind: 'place_order',
      symbol: 'BTC-USDC',
      side: 'sell',
      type: 'limit',
      amount: '0.01',
      price: '59990',
      timeInForce: 'GTC',
      reduceOnly: false,
      clientOrderKey: `order:${J}:${RUN}:${(orders += 1)}`,
      builderFee: null,
    });
  }
  let fees = [];
  await expect
    .poll(
      async () => {
        const body = await venueRecord(traderOwner, '/fills', { since: since.toISOString() });
        fees = body.value.filter((f) => f.feeAsset === ASSET && !/^0(\.0+)?$/.test(f.builderFee)).map((f) => f.builderFee);
        return fees.length;
      },
      { timeout: 30_000 },
    )
    .toBeGreaterThanOrEqual(sells);
  return sumDecimal(fees);
}

/** Funds the pot with builder fees once svc-trade has posted them to the ledger (it posts on its own cadence). */
async function fundPotFromFees(reference, amount) {
  await expect
    .poll(
      async () => {
        try {
          await fundPot(`${reference}-${Date.now().toString(36)}`, amount);
          return 'posted';
        } catch (err) {
          return String(err).slice(0, 200);
        }
      },
      { timeout: 90_000, intervals: [5_000] },
    )
    .toBe('posted');
}

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
  // Basic is what trading and the claims need.
  await verifyAs(page, me, 'Basic');
  expect(fund(me.email, 'USDT', '500').tx).toBeTruthy();
  run.write({ me });

  expect(await mine(me)).toEqual({ rewards: [], totals: [], more: false });
  await signIn(page, me);
  const hub = await openHub(page);
  await expect(hub).toHaveAttribute('data-state', 'ready');
  await expect(hub.getByTestId('rewards-empty')).toContainText('No rewards so far');
  await expect(hub.getByTestId('rewards-totals')).toHaveCount(0);
  await expect(hub.getByTestId('reward-row')).toHaveCount(0);
  await expect(hub.getByRole('link', { name: 'Find a campaign' })).toHaveAttribute('href', '/campaigns');
});

test(`${J} #2 opens it with rewards in each state: owed, on hold and still open, each with its reason, never spendable; paid rows carry the chain transaction`, async ({
  page,
}) => {
  test.setTimeout(420_000);
  const { me } = state('me');
  // The pot's USDC comes from builder fees this file earns on the TEST venue: enough for #2 to #5's rewards.
  const fees = await earnBuilderFees(me, 3);
  await fundPotFromFees(`TEST-${J}-2-${tag}`, fees);
  run.write({ fees });

  const owed = await liveCampaign(`TEST owed at once ${tag}`, { holdSeconds: 0 });
  const held = await liveCampaign(`TEST held for review ${tag}`, { holdSeconds: 3600 });
  // Past the TEST ceiling: INTAFACED may not owe it, so it is still open and tried again on each pass.
  const open = await liveCampaign(`TEST over the ceiling ${tag}`, { holdSeconds: 0, amount: OVER_CEILING, budget: '200' });
  await completeAll(me, [owed.id, held.id, open.id]);
  for (const c of [owed, held, open]) await call(me, 'POST', 'tasks.claim', { campaignId: c.id });
  await expect.poll(async () => (await progressOf(me, owed.id)).reward.state, { timeout: 60_000 }).toBe('owed');
  await expect.poll(async () => (await progressOf(me, held.id)).reward.state, { timeout: 60_000 }).toBe('owed');
  expect((await progressOf(me, open.id)).reward).toMatchObject({ state: 'pending_retry', reason: 'ledger.reward_ceiling_exceeded' });
  run.write({ owedId: owed.id, heldId: held.id, openId: open.id });

  await signIn(page, me);
  const hub = await openHub(page);
  // Owed: INTAFACED owes it, and it is not in the wallet or any balance.
  const due = row(hub, owed.id);
  await expect(due).toHaveAttribute('data-status', 'owed');
  await expect(due.getByTestId('reward-status')).toHaveText('Owed');
  await expect(due.getByTestId('reward-amount')).toHaveText(`${REWARD} ${ASSET}`);
  await expect(due.getByTestId('reward-why')).toContainText('Owed to you by INTAFACED since');
  await expect(due.getByTestId('reward-why')).toContainText('It is not in your wallet and not part of any balance');
  await expect(due.getByTestId('reward-tx')).toHaveCount(0);

  // On hold: owed, with the time left on its hold.
  const waiting = row(hub, held.id);
  await expect(waiting).toHaveAttribute('data-status', 'on_hold');
  await expect(waiting.getByTestId('reward-status')).toHaveText('On hold');
  await expect(waiting.getByTestId('reward-why')).toContainText('Owed to you by INTAFACED. It is paid to your connected wallet once');
  await expect(waiting.getByTestId('reward-why')).toContainText(/(59 minutes|1 hour) left, until/);
  await expect(waiting.getByTestId('reward-tx')).toHaveCount(0);

  // Still open: retried under the same reference, with the real reason.
  const still = row(hub, open.id);
  await expect(still).toHaveAttribute('data-status', 'still_open');
  await expect(still.getByTestId('reward-status')).toHaveText('Still open');
  await expect(still.getByTestId('reward-why')).toHaveAttribute('data-reason', 'ledger.reward_ceiling_exceeded');
  await expect(still.getByTestId('reward-why')).toContainText('Waiting: INTAFACED’s limit on rewards it may owe');

  // The history: one table holds every reward, each once.
  const history = hub.getByRole('region', { name: 'Rewards and history' });
  await expect(history).toBeVisible();
  await expect(history.getByTestId('reward-row')).toHaveCount(3);
  for (const c of [owed, held, open]) await expect(row(history, c.id)).toHaveCount(1);

  // Totals are summed from the rows, and an owed total is named as owed, never as a balance or spendable.
  await expect(total(hub, 'owed').getByTestId('rewards-total-amount')).toHaveText(`${REWARD} ${ASSET}`);
  await expect(total(hub, 'owed')).toContainText('Owed by INTAFACED, not in your wallet');
  await expect(total(hub, 'on_hold').getByTestId('rewards-total-amount')).toHaveText(`${REWARD} ${ASSET}`);
  await expect(total(hub, 'still_open').getByTestId('rewards-total-amount')).toHaveText(`${OVER_CEILING} ${ASSET}`);
  await expect(hub.getByTestId('rewards-total')).toHaveCount(3);
  await expect(hub.getByTestId('rewards-totals')).not.toContainText(/balance|available|spendable/i);

  // Paid: a reward paid to the connected wallet carries its chain transaction link. Nothing pays an owed reward to a
  // wallet yet, so no row here is paid (the step is left: see the PR).
  await expect(hub.locator('[data-testid="reward-row"][data-status="paid"] [data-testid="reward-chain-tx"]')).toHaveCount(1, {
    timeout: 5_000,
  });
});

test(`${J} #3 watches a held reward when its release time passes: paid once to the connected wallet; under a posting freeze it stays owed and is paid once after it lifts`, async ({
  page,
  browser,
}) => {
  test.setTimeout(300_000);
  const { me } = state('me', 'fees');
  const hold = await liveCampaign(`TEST short hold ${tag}`, { holdSeconds: 45 });
  await completeAll(me, [hold.id]);
  const claimed = await call(me, 'POST', 'tasks.claim', { campaignId: hold.id });
  await expect.poll(async () => (await progressOf(me, hold.id)).reward.state, { timeout: 60_000 }).toBe('owed');
  const until = new Date(claimed.reward.holdUntil).getTime();
  await page.waitForTimeout(Math.max(0, until - Date.now()));
  // Paid once to the connected wallet, with its chain transaction. Nothing pays an owed reward to a wallet yet.
  await expect.poll(async () => (await progressOf(me, hold.id)).reward.state, { timeout: 30_000 }).toBe('paid');

  // With the platform posting freeze on when a hold ends, the reward stays owed, and is paid once after it lifts.
  const frozenHold = await liveCampaign(`TEST hold under freeze ${tag}`, { holdSeconds: 45 });
  await completeAll(me, [frozenHold.id]);
  const second = await call(me, 'POST', 'tasks.claim', { campaignId: frozenHold.id });
  try {
    await setPostingFreeze(browser, true);
    await page.waitForTimeout(Math.max(0, new Date(second.reward.holdUntil).getTime() - Date.now()) + 12_000);
    expect((await progressOf(me, frozenHold.id)).reward.state).toBe('owed');
    await signIn(page, me);
    const hub = await openHub(page);
    await expect(row(hub, frozenHold.id)).toHaveAttribute('data-status', 'owed');
    await setPostingFreeze(browser, false);
    await expect.poll(async () => (await progressOf(me, frozenHold.id)).reward.state, { timeout: 60_000 }).toBe('paid');
  } finally {
    await setPostingFreeze(browser, false);
  }
  await page.waitForTimeout(12_000);
  const reward = (await progressOf(me, frozenHold.id)).reward;
  expect(reward.attempts.filter((a) => a.outcome === 'paid')).toHaveLength(1);
});

const LOCK_STEP = { title: 'TEST sell BTC', event: 'trade.fill', market: SYMBOL, side: 'sell', count: 1 };

test(`${J} #4 fails the condition on a locked reward: it shows forfeited once and is not reissued; nothing was ever paid`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const { me } = state('me', 'fees');
  const locked = await liveCampaign(`TEST locked reward ${tag}`, {
    holdSeconds: 0,
    lock: { kind: 'locked', seconds: 60, step: LOCK_STEP },
  });
  await completeAll(me, [locked.id]);
  const claimed = await call(me, 'POST', 'tasks.claim', { campaignId: locked.id });
  await expect.poll(async () => (await progressOf(me, locked.id)).reward.state, { timeout: 60_000 }).toBe('locked');
  const reward = (await progressOf(me, locked.id)).reward;
  expect(reward).toMatchObject({ form: 'locked', ledgerTxId: null, owed: null });
  expect(reward.lock.condition).toEqual({ title: LOCK_STEP.title, done: 0, target: 1 });

  await signIn(page, me);
  let hub = await openHub(page);
  await expect(row(hub, locked.id)).toHaveAttribute('data-status', 'locked');
  await expect(row(hub, locked.id).getByTestId('reward-status')).toHaveText('Locked');
  await expect(row(hub, locked.id).getByTestId('reward-why')).toContainText(`Locked until you complete “${LOCK_STEP.title}” (0 of 1)`);

  // The customer never sells: the lock ends without its step, and it is forfeited once.
  await page.waitForTimeout(Math.max(0, new Date(reward.lock.until).getTime() - Date.now()));
  // A locked reward forfeits a grace minute after its lock ends (late fills may still count), then on the next pass.
  await expect.poll(async () => (await progressOf(me, locked.id)).reward.state, { timeout: 150_000 }).toBe('forfeited');
  hub = await openHub(page);
  await expect(row(hub, locked.id)).toHaveAttribute('data-status', 'closed');
  await expect(row(hub, locked.id).getByTestId('reward-why')).toHaveAttribute('data-reason', 'campaigns.lock_condition_failed');
  await expect(row(hub, locked.id).getByTestId('reward-why')).toContainText(`Forfeited: “${LOCK_STEP.title}” was not completed by`);
  await expect(row(hub, locked.id).getByTestId('reward-why')).toContainText('It is not given again.');

  // Not reissued: claiming again returns the same forfeited reward, and later reconciler passes add nothing.
  const again = await call(me, 'POST', 'tasks.claim', { campaignId: locked.id });
  expect(again.created).toBe(false);
  expect(again.reward).toMatchObject({ rewardKey: claimed.reward.rewardKey, state: 'forfeited' });
  await page.waitForTimeout(12_000);
  const after = (await progressOf(me, locked.id)).reward;
  expect(after.attempts.filter((a) => a.outcome === 'forfeited')).toHaveLength(1);
  expect(after.attempts.filter((a) => a.outcome === 'locked')).toHaveLength(1);
  // Nothing was ever paid: never owed, never unlocked or paid out.
  expect(after.owed).toBeNull();
  expect(after.attempts.filter((a) => ['owed', 'posted', 'unlocked', 'paid'].includes(a.outcome))).toEqual([]);
  expect((await mine(me)).rewards.filter((r) => r.campaignId === locked.id)).toHaveLength(1);
});

test(`${J} #5 tries to spend or withdraw a reward that is still owed: the screen explains it is owed by INTAFACED and not yet in the wallet; nothing is sent`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  const { me, owedId } = state('me', 'owedId');
  const before = (await progressOf(me, owedId)).reward;
  expect(before.state).toBe('owed');
  await signIn(page, me);
  const hub = await openHub(page);
  const due = row(hub, owedId);
  // Every request the page sends from the click on: nothing may go out.
  const sent = [];
  page.on('request', (req) => {
    if (req.method() !== 'GET') sent.push(`${req.method()} ${req.url()}`);
  });
  await due.getByRole('button', { name: 'Spend or withdraw' }).click();
  const note = due.getByTestId('reward-spend-note');
  await expect(note).toHaveAttribute('role', 'status');
  await expect(note).toContainText('This reward is owed to you by INTAFACED and is not in your wallet yet');
  await expect(note).toContainText('Nothing was sent.');
  await page.waitForTimeout(2_000);
  expect(sent).toEqual([]);
  const after = (await progressOf(me, owedId)).reward;
  expect(after).toMatchObject({ state: 'owed', ledgerTxId: null });
  expect(after.attempts).toEqual(before.attempts);
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
