// World: book, market
import { test, expect } from './journey.mjs';
import { api, bestPrices, journeyState, toUnits } from './stack.mjs';
import { fundedTrader, signIn } from './desk.mjs';

// J-campaigns-14, in the running app (docs/roadmap/journeys.json): get a VIP trial pass and see my loyalty tier. One test
// per step, titled "J-campaigns-14 #<n>", run in order on one TEST account funded with TEST USDT through the real ledger.
// The start: tiers are defined on spend. #1 publishes a TEST tier programme through svc-trade's two-person fee door (the
// default pair group keeps the stack's own regular rates, maker 0.08% and taker 0.10%, so every other journey trades as
// it always did; TEST tiers test-vip-1 at taker 0.09% and test-vip-2 at taker 0.08%, reached only on TEST volumes no
// account here trades, and no snapshot time, so no snapshot runs). A pass is granted as a campaign's reward: the stack's
// two LOCAL TEST founders make a `trial_pass` campaign (A creates and asks, B approves, A activates) and A grants its pass
// through svc-campaigns' operator door. Each "next fill" is a small IOC buy of IFC/USDT at the best ask, a taker fill
// against the house quotes, whose fee rate svc-trade reports from what it posted. The schedule goes back after #4.
const J = 'J-campaigns-14';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
const PERKS = '/uc/promotion/perks';
const DAY = 86_400_000;

/** TEST rates through the real write path, not owner decisions. */
const row = (tierId, makerBps, takerBps) => ({ pairGroup: 'all-others', tierId, zeroFee: false, makerBps, takerBps, minFee: null });
const SCHEDULE = {
  defaultPairGroup: 'all-others',
  rows: [row('regular', '8', '10'), row('test-vip-1', '6', '9'), row('test-vip-2', '5', '8')],
  perpetual: { makerBps: '2', takerBps: '5' },
};
/** TEST thresholds, not owner values. No snapshot time: no snapshot runs, so a tier here comes from a pass alone. */
const TIERED = {
  ...SCHEDULE,
  tierProgram: {
    thresholds: [
      { tierId: 'test-vip-1', minVolume30d: '1000' },
      { tierId: 'test-vip-2', minVolume30d: '5000' },
    ],
    volumeQuotes: ['USDT', 'USDC'],
    snapshotTimeUtc: null,
    downgradeGraceDays: null,
    subAccounts: null,
    botsAndCopy: null,
  },
};
/** Each TEST tier's taker rate as svc-trade reports a fill's fee rate (bps / 10,000). */
const RATE = { regular: '0.001', 'test-vip-1': '0.0009', 'test-vip-2': '0.0008' };
/** The first pass lasts ten minutes; the second, which replaces it, two. */
const FIRST = { tierId: 'test-vip-2', seconds: 600 };
const SECOND = { tierId: 'test-vip-1', seconds: 120 };

test.describe.configure({ mode: 'default' });

function state(...keys) {
  const s = run.read();
  for (const k of ['account', 'userId', ...keys])
    if (!s[k]) throw new Error(`${J}: an earlier step left no ${k}, so this step has nothing to act on`);
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
  const result = res.json?.result?.data;
  if (!result) throw new Error(`${what} refused (${res.status}): ${res.text.slice(0, 300)}`);
  return result;
};

/** Write `schedule` as the next fee schedule version, ten seconds from now, and wait until the person's tier read uses it. */
async function publish(schedule, reason, client) {
  const { ctx, pair } = await operators();
  const written = await gates.setFeeSchedule(ctx, schedule, {
    effectiveAt: Date.now() + 10_000,
    reason: `LOCAL TEST ${J}: ${reason}`,
    sessions: pair,
  });
  await expect
    .poll(async () => (await myTier(client)).scheduleVersion, { timeout: 45_000, message: `fee schedule v${written.version} in force` })
    .toBe(`v${written.version}`);
  return written;
}

/** The person's own fee tier read (svc-trade `GET /api/v1/account/fee-tier`), as the perks room reads it. */
async function myTier(client) {
  const { status, body } = await client.get('/api/v1/account/fee-tier');
  expect(status, JSON.stringify(body).slice(0, 300)).toBe(200);
  return body;
}

/** A TEST `trial_pass` campaign live now, granting `terms`. No budget and no reward: a pass pays nothing. */
async function liveTrialPassCampaign(terms, n) {
  const { ctx, pair } = await operators();
  const a = await pair.a.campaignsOpsToken();
  const b = await pair.b.campaignsOpsToken();
  const definition = {
    name: `TEST trial pass ${n} ${tag}`,
    type: 'trial_pass',
    rules: `TEST rules: a VIP trial pass at ${terms.tierId} for ${terms.seconds} seconds, granted as a reward.`,
    startsAt: new Date(Date.now() - 60_000).toISOString(),
    endsAt: new Date(Date.now() + DAY).toISOString(),
    participation: { exclusions: [], regionScope: 'platform' },
    limits: { perCustomer: { count: 1, periodSeconds: 86_400 }, totalRedemptions: null },
    trialPass: terms,
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

/** Operator A grants `campaignId`'s pass to the person, as the campaign's reward. */
async function grantPass(campaignId, userId) {
  const { ctx, pair } = await operators();
  const input = { campaignId, accountId: userId, reason: `LOCAL TEST ${J}: the campaign's reward` };
  return data(
    await ctx.edge.mutate('campaigns', 'ops.campaigns.trialPass.grant', input, await pair.a.campaignsOpsToken()),
    'ops.campaigns.trialPass.grant',
  );
}

/** The person's next fill: a small IOC buy of IFC/USDT at the best ask, taken from the house quotes. */
async function nextFill(client, label) {
  const { ask } = await bestPrices('IFC/USDT');
  const placed = await client.post('/api/v1/orders', {
    symbol: 'IFC/USDT',
    side: 'buy',
    type: 'limit',
    amount: '10',
    price: ask,
    timeInForce: 'IOC',
    clientOrderId: `jc14-${label}-${Date.now().toString(36)}`,
  });
  expect(placed.status, JSON.stringify(placed.body).slice(0, 300)).toBeLessThan(300);
  let fills = [];
  await expect
    .poll(
      async () => {
        const { status, body } = await client.get('/api/v1/account/trades?symbol=IFC%2FUSDT&limit=100');
        expect(status).toBe(200);
        fills = (Array.isArray(body) ? body : (body.trades ?? [])).filter((f) => f.order === placed.body.id);
        return fills.length;
      },
      { timeout: 30_000, message: `a fill of ${placed.body.id}` },
    )
    .toBeGreaterThan(0);
  return fills;
}

/** Every fill a taker at `rate`, its fee what that rate makes of what it was charged on (rounded either way by one unit). */
function chargedAt(fills, rate) {
  const [whole, frac = ''] = rate.split('.');
  const scaled = BigInt(whole + frac.padEnd(4, '0').slice(0, 4)); // bps
  for (const fill of fills) {
    expect(fill.takerOrMaker).toBe('taker');
    expect(fill.fee.rate).toBe(rate);
    const base = fill.fee.currency === 'IFC' ? toUnits(fill.amount) : toUnits(fill.cost);
    const expected = (base * scaled) / 10_000n;
    const diff = toUnits(fill.fee.cost) - expected;
    expect(diff >= -1n && diff <= 1n, `fee ${fill.fee.cost} ${fill.fee.currency} on ${fill.amount} for ${fill.cost} at ${rate}`).toBe(true);
  }
}

/** "2026-11-16 03:02:00 UTC", as the room writes a pass's times. */
const utc = (iso) => `${iso.slice(0, 19).replace('T', ' ')} UTC`;

const badge = (page) => page.getByTestId('perks-pass-badge');

test.afterAll(async () => {
  // The stack's schedule goes back to the regular rates with no tier programme, whatever a step left.
  if (!gates) return;
  const { ctx, pair } = await operators();
  await gates.setFeeSchedule(ctx, SCHEDULE, {
    effectiveAt: Date.now() + 10_000,
    reason: `LOCAL TEST ${J}: tier programme taken away`,
    sessions: pair,
  });
});

test(`${J} #1 opens /uc/promotion/perks: my loyalty tier, the multiplier, the next tier, and a points-basis tier's blocker`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  const who = await fundedTrader(page, 'jc14', '5000');
  const client = await api(who);
  const rank = await client.get('/api/identity/trpc/rank.get');
  expect(rank.status, JSON.stringify(rank.body).slice(0, 300)).toBe(200);
  const userId = rank.body.result.data.userId;
  run.reset({ account: who, userId });

  await publish(TIERED, 'TEST tier programme on spend', client);
  const tier = await myTier(client);
  expect(tier).toMatchObject({ tier: 'regular', pass: null, next: { tierId: 'test-vip-1', minVolume30d: '1000', remaining: '1000' } });

  await signIn(page, who);
  await page.goto(PERKS);
  // My loyalty tier, reached on spend.
  await expect(page.getByTestId('perks-tier')).toHaveAttribute('data-tier', 'regular');
  await expect(page.getByTestId('perks-tier')).toContainText('Your tier: regular');
  await expect(page.getByTestId('perks-tier')).toContainText('Reached on spend');
  // The multiplier: regular's taker rate over regular's, from the published schedule.
  await expect(page.getByTestId('perks-multiplier')).toHaveText('Fee multiplier: ×1 (taker 0.10%, maker 0.08%)');
  // The next tier, with what is left to reach it.
  await expect(page.getByTestId('perks-next')).toContainText('test-vip-1 from 1000, 1000 to go');
  // A tier on a points basis waits for the owner, and says so.
  const points = page.getByTestId('perks-points-tier');
  await expect(points).toHaveAttribute('data-code', 'owner.decision');
  await expect(points).toContainText('Waiting for an owner decision:');
  await expect(page.getByTestId('perks-points-question')).toContainText('Should a loyalty tier be reached on points');
  await expect(page.getByTestId('perks-pass-none')).toHaveText('No trial pass is in force.');
  await expect(badge(page)).toHaveCount(0);
});

test(`${J} #2 is granted a trial pass: a badge with the end time, and the fee discount applies to my next fill`, async ({ page }) => {
  test.setTimeout(180_000);
  const { account: who, userId } = state();
  const client = await api(who);
  // Before the pass, the next fill is charged at regular's rate.
  chargedAt(await nextFill(client, 'before'), RATE.regular);

  const campaign = await liveTrialPassCampaign(FIRST, 1);
  const grant = await grantPass(campaign.id, userId);
  expect(grant).toMatchObject({ granted: true, replaced: null, pass: { tierId: FIRST.tierId, endedAt: null } });
  const pass = grant.pass;
  expect(pass.passKey).toBe(`trial-pass:${campaign.id}:${userId}`);
  expect(Date.parse(pass.endsAt) - Date.parse(pass.startsAt)).toBe(FIRST.seconds * 1000);
  // The same grant again is the same pass: nothing more is written.
  expect(await grantPass(campaign.id, userId)).toMatchObject({ granted: false, pass: { passKey: pass.passKey, endsAt: pass.endsAt } });

  await signIn(page, who);
  await page.goto(PERKS);
  await expect(badge(page)).toHaveAttribute('data-pass', pass.passKey);
  await expect(badge(page)).toHaveText(`VIP trial pass ${FIRST.tierId} until ${utc(pass.endsAt)}`);
  await expect(page.getByTestId('perks-tier')).toHaveAttribute('data-tier', FIRST.tierId);
  await expect(page.getByTestId('perks-multiplier')).toHaveText('Fee multiplier: ×0.8 (taker 0.08%, maker 0.05%)');

  // The fee discount applies to my next fill: svc-trade charged and posted it at the pass's tier.
  chargedAt(await nextFill(client, 'pass-1'), RATE[FIRST.tierId]);
  run.write({ first: pass });
});

test(`${J} #3 is granted a second pass while one is active: the later replaces the earlier`, async ({ page }) => {
  test.setTimeout(180_000);
  const { account: who, userId, first } = state('first');
  const client = await api(who);
  const campaign = await liveTrialPassCampaign(SECOND, 2);
  const grant = await grantPass(campaign.id, userId);
  expect(grant.granted).toBe(true);
  // The earlier ends at the later one's grant, replaced by it, though it named a higher tier and had time left.
  expect(grant.replaced).toMatchObject({ passKey: first.passKey, endReason: 'replaced', replacedBy: grant.pass.passKey });
  expect(grant.replaced.endedAt).toBe(grant.pass.startsAt);
  expect(Date.parse(grant.replaced.endedAt)).toBeLessThan(Date.parse(first.endsAt));

  const tier = await myTier(client);
  expect(tier.pass).toMatchObject({ passKey: grant.pass.passKey, tierId: SECOND.tierId, endedAt: null });
  expect(tier.tier).toBe(SECOND.tierId);

  await signIn(page, who);
  await page.goto(PERKS);
  await expect(badge(page)).toHaveCount(1);
  await expect(badge(page)).toHaveAttribute('data-pass', grant.pass.passKey);
  await expect(badge(page)).toHaveText(`VIP trial pass ${SECOND.tierId} until ${utc(grant.pass.endsAt)}`);
  const earlier = page.locator(`[data-pass-row="${first.passKey}"]`);
  await expect(earlier).toHaveAttribute('data-end', 'replaced');
  await expect(earlier).toContainText(`${utc(grant.replaced.endedAt)}: Replaced by a later pass`);

  // Orders now take the later pass's tier.
  chargedAt(await nextFill(client, 'pass-2'), RATE[SECOND.tierId]);
  run.write({ first, second: grant.pass, replacedAt: grant.replaced.endedAt });
});

test(`${J} #4 the pass ends: the override ends once and the badge goes`, async ({ page }) => {
  test.setTimeout(300_000);
  const { account: who, first, second, replacedAt } = state('first', 'second', 'replacedAt');
  const client = await api(who);
  await signIn(page, who);
  await page.goto(PERKS);
  await expect(badge(page)).toHaveAttribute('data-pass', second.passKey);

  // The room reads every few seconds: the badge goes once the pass's end time has passed, with no reload.
  const left = Date.parse(second.endsAt) - Date.now();
  await expect(badge(page)).toHaveCount(0, { timeout: Math.max(left, 0) + 30_000 });
  expect(Date.now()).toBeGreaterThanOrEqual(Date.parse(second.endsAt));
  await expect(page.getByTestId('perks-pass-none')).toHaveText('No trial pass is in force.');
  await expect(page.getByTestId('perks-tier')).toHaveAttribute('data-tier', 'regular');
  const ended = page.locator(`[data-pass-row="${second.passKey}"]`);
  await expect(ended).toHaveAttribute('data-end', 'expired');
  await expect(ended).toContainText(`${utc(second.endsAt)}: Ended at its end time`);

  // Ended once: at its end time, and read again later it is the same end; the replaced pass keeps its own end.
  const once = await myTier(client);
  expect(once.tier).toBe('regular');
  expect(once.pass).toBeNull();
  const rows = Object.fromEntries(once.passes.map((p) => [p.passKey, p]));
  expect(rows[second.passKey]).toMatchObject({ endReason: 'expired', endedAt: second.endsAt });
  expect(rows[first.passKey]).toMatchObject({ endReason: 'replaced', endedAt: replacedAt });
  await new Promise((resolve) => setTimeout(resolve, 6_000));
  const again = await myTier(client);
  expect(again.passes.filter((p) => p.passKey === second.passKey || p.passKey === first.passKey)).toEqual([
    rows[second.passKey],
    rows[first.passKey],
  ]);

  // The override is gone: the next fill is charged at regular's rate again.
  chargedAt(await nextFill(client, 'after'), RATE.regular);
});
