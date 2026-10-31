#!/usr/bin/env node
/**
 * LOCAL TEST merchant pricing — puts one TEST business on a TEST risk tier through svc-pay's own two-founder doors. Every
 * business a journey opens goes on its priced tier at once (merchant.mjs openBusiness), since the stack runs with
 * PAY_MERCHANT_CONTROLS=required and an untiered business can take no payment; J-merchant-07 also reads Pricing and Fees on
 * each kind (#3) and needs today's payout limit exceeded (#6, which puts the business back on its priced tier after). The payout steps after #3 (#6, #7, #8) rely on the priced tier's caps and
 * thresholds, so a change to `journeyTier`'s shared caps changes them too. Local only.
 *
 *   node tooling/scripts/local-test-merchant-pricing.mjs <merchantId> --tier open|priced|blank|capped [--payout-not-charged]
 *
 *   --tier open           the tier every business a journey opens starts on (merchant.mjs openBusiness): TEST caps and a TEST
 *                         fee for every asset a journey takes a payment in (JOURNEY_OPEN_ASSETS)
 *   --tier priced         the business's own tier, with a TEST tier-layer USDT fee (JOURNEY_PRICING_RULE)
 *   --tier blank          a second tier of its own with no fee at all, so the calculator has nothing to price
 *   --tier capped         a third tier of its own with no fee and a TEST daily payout cap of 1 USDT
 *                         (JOURNEY_CAPPED_DAILY_PAYOUT), so a settlement's payout is more than is left today (J-merchant-07 #6)
 *   --payout-not-charged  the tier publishes its payout fee as not charged; without it the tier publishes none
 *
 * Each change is one founder submitting and a DIFFERENT founder confirming with the hash of the change they were shown
 * (founderAdmin.control.configure.* for the tier and its fee, founderAdmin.changes.* for the move). The two are the
 * stack's enrolled LOCAL TEST founders (svc-pay's founder doors accept only identity's founder pair), or the two TEST
 * operators on a stack without them, the same pair local-test-gates' approverSessions signs in. Nothing is written to a table. Each tier belongs to one business (its id
 * carries the business's id) and stays off the shared ladder (merchantVisible false), so no other account sees it. A
 * run reads the founder views first and only changes what differs, so a second run is a set of noops. Prints JSON.
 *
 * Every figure here is a TEST VALUE for the local stack, not a proposal for a real price or limit.
 */
import { assertActiveLocalStack } from './local-test-state.mjs';
import { describeMoneyRefusal, founderChange, populateUuid, trpcData } from './local-test-world.mjs';

export const PRICING_USAGE = 'usage: local-test-merchant-pricing.mjs <merchantId> --tier open|priced|blank|capped [--payout-not-charged]';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TIER_KINDS = ['open', 'priced', 'blank', 'capped'];

/** The arguments, or null. Everything is refused before the stack is touched. */
export function pricingArgs(argv) {
  const [merchantId, ...rest] = argv;
  if (!UUID.test(String(merchantId ?? ''))) return null;
  let tier = null;
  let payoutNotCharged = false;
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--tier' && TIER_KINDS.includes(rest[i + 1]) && tier === null) tier = rest[(i += 1)];
    else if (rest[i] === '--payout-not-charged' && !payoutNotCharged) payoutNotCharged = true;
    else return null;
  }
  return tier ? { merchantId: merchantId.toLowerCase(), tier, payoutNotCharged } : null;
}

/** TEST VALUE tier-layer fee: 2.50% up to 10,000 USDT of monthly volume, then 1.50% + 0.30, at least 0.50; the platform keeps fractions. */
export const JOURNEY_PRICING_RULE = {
  assetCode: 'USDT',
  bands: [
    { fromAmount: '0', feeBps: 250, flatFee: null },
    { fromAmount: '10000', feeBps: 150, flatFee: '0.3' },
  ],
  spreadBps: null,
  roundingBeneficiary: 'platform',
  minFee: '0.5',
};

/** TEST VALUE daily payout cap of the capped tier: below any TEST settlement's net, so its payout is over today's limit. */
export const JOURNEY_CAPPED_DAILY_PAYOUT = '1';

/**
 * The assets journeys take payments in: USDT (most), USDC (J-merchant-04's links), USD (J-developer-02's sandbox card
 * payment) and EUR (J-merchant-04's TEST bank transfer). The `open` tier caps and prices each; J-merchant-07's tiers name
 * USDT alone, so its calculator still opens on USDT.
 */
export const JOURNEY_OPEN_ASSETS = ['USDT', 'USDC', 'USD', 'EUR'];

/**
 * TEST VALUE intake caps for one asset: svc-pay refuses a payment with PAY_MERCHANT_CONTROLS=required unless the tier caps
 * one payment, a day and a month in its asset (pay.caps_unconfigured). Far above any journey's TEST payment (at most 100),
 * so no journey meets them by chance.
 */
export const journeyIntakeCaps = (assetCode) => [
  { kind: 'per_payment', assetCode, limit: '1000' },
  { kind: 'daily_intake', assetCode, limit: '10000' },
  { kind: 'monthly_intake', assetCode, limit: '100000' },
];

/** The tier-layer fee rules a kind holds: JOURNEY_PRICING_RULE's terms per asset on `open`, USDT on `priced`, none else. */
export function journeyPricingRules(kind) {
  if (kind === 'open') return JOURNEY_OPEN_ASSETS.map((assetCode) => ({ ...JOURNEY_PRICING_RULE, assetCode }));
  return kind === 'priced' ? [JOURNEY_PRICING_RULE] : [];
}

/**
 * The TEST tier for one business. Its caps and thresholds are the LOCAL TEST tier's (local-test-world.mjs), so the payout
 * steps after it behave as on that tier. A tier id is a slug of at most 32 characters, so it carries 8 hex of the id.
 */
export function journeyTier(merchantId, kind, payoutNotCharged) {
  const short = merchantId.replace(/-/g, '').slice(0, 8).toLowerCase();
  return {
    id: `j07-${kind}-${short}`,
    name: `TEST ${kind} tier ${short}`,
    archetype: 'standard',
    caps: [
      { kind: 'daily_payout', assetCode: 'USDT', limit: kind === 'capped' ? JOURNEY_CAPPED_DAILY_PAYOUT : '500' },
      { kind: 'beneficiaries_per_day', limit: 500 },
      ...(kind === 'open' ? JOURNEY_OPEN_ASSETS : ['USDT']).flatMap(journeyIntakeCaps),
    ],
    reserve: null,
    approvalThresholds: [{ assetCode: 'USDT', amount: '10' }],
    founderThresholds: [{ assetCode: 'USDT', amount: '1000' }],
    approvalTtlSeconds: 86_400,
    merchantVisible: false,
    // Always sent: svc-pay keeps a published payout fee when the field is left out, and null withdraws it.
    payoutFee: payoutNotCharged ? { kind: 'not_charged' } : null,
  };
}

const num = (value) => {
  const [whole, frac = ''] = String(value).split('.');
  return `${BigInt(whole)}.${frac.replace(/0+$/, '')}`;
};
const capKey = (cap) =>
  cap.kind === 'beneficiaries_per_day' ? `${cap.kind}=${cap.limit}` : `${cap.kind}:${cap.assetCode}=${num(cap.limit)}`;
const thresholdKey = (t) => `${t.assetCode}=${num(t.amount)}`;
const sameSet = (a, b, key) => {
  const left = (a ?? []).map(key).sort();
  const right = (b ?? []).map(key).sort();
  return left.length === right.length && left.every((v, i) => v === right[i]);
};

/**
 * Whether the tier must be written. `listed` is founderAdmin.control.tiers.list. Every term is compared, the payout fee
 * included, so a tier left with a published payout fee by an earlier run is put back to none when none is asked for.
 */
export function planTierUpsert({ listed, tier }) {
  const have = (listed ?? []).find((t) => t.id === tier.id) ?? null;
  if (!have) return { kind: 'upsert', expectedVersion: '0' };
  const same =
    have.name === tier.name &&
    have.archetype === tier.archetype &&
    (have.reserve ?? null) === null &&
    sameSet(have.caps, tier.caps, capKey) &&
    sameSet(have.approvalThresholds, tier.approvalThresholds, thresholdKey) &&
    sameSet(have.founderThresholds, tier.founderThresholds, thresholdKey) &&
    have.approvalTtlSeconds === tier.approvalTtlSeconds &&
    have.merchantVisible === tier.merchantVisible &&
    (have.payoutFee?.kind ?? null) === (tier.payoutFee?.kind ?? null);
  return same ? { kind: 'exists', version: String(have.version) } : { kind: 'upsert', expectedVersion: String(have.version) };
}

const ruleKey = (r) =>
  JSON.stringify([
    r.assetCode,
    r.bands.map((b) => [num(b.fromAmount), b.feeBps, b.flatFee === null || b.flatFee === undefined ? null : num(b.flatFee)]),
    r.spreadBps ?? null,
    r.roundingBeneficiary,
    r.minFee == null ? null : num(r.minFee),
    r.maxFee == null ? null : num(r.maxFee),
  ]);

/**
 * Whether the tier's fee layer must be written. `live` is founderAdmin.control.pricing.rules for the tier layer and this
 * tier (live rules only); `wanted` the rules it must hold ([] for none). The expected version is the newest live rule's:
 * svc-pay versions a layer by its newest rule, and a set always leaves at least one live rule here.
 */
export function planPricingLayer({ live, wanted }) {
  const rows = live ?? [];
  const expectedVersion = rows.reduce((max, r) => (BigInt(r.version) > max ? BigInt(r.version) : max), 0n).toString();
  const same = rows.length === wanted.length && rows.map(ruleKey).sort().join('|') === wanted.map(ruleKey).sort().join('|');
  return same ? { kind: 'exists', version: expectedVersion } : { kind: 'set', expectedVersion };
}

/** `profile` is founderAdmin.control.merchant.get: { tierId, version }. */
export function planMove({ profile, tierId }) {
  if (profile?.tierId === tierId) return { kind: 'exists', version: String(profile.version ?? '0') };
  return { kind: 'move', expectedVersion: String(profile?.version ?? '0') };
}

/** Request ids are business keys: the same change from the same version is the same request. */
export const tierUpsertRequestId = (tier, expectedVersion) =>
  populateUuid(`journey-tier-upsert-${tier.id}-v${expectedVersion}-${tier.payoutFee?.kind ?? 'none'}`);
export const tierLayerRequestId = (tierId, expectedVersion) => populateUuid(`journey-tier-layer-${tierId}-v${expectedVersion}`);
export const tierMoveRequestId = (merchantId, tierId, expectedVersion) =>
  populateUuid(`journey-tier-move-${merchantId}-${tierId}-v${expectedVersion}`);

/**
 * The pair svc-pay's founder doors accept: the enrolled founders once the stack has them (identity's founder pair),
 * else the TEST operators. Each session is a plain MFA sign-in, what a founder desk holds.
 */
async function founderPair(ctx) {
  const gates = await import('./local-test-gates.mjs');
  const gctx = await gates.makeContext({ log: (m) => ctx.log(`merchant pricing founders: ${m}`) });
  const sessions = await gates.approverSessions(gctx);
  const side = (letter) => ({ letter, loginToken: sessions[letter].token });
  return { ok: true, gates, gctx, a: side('a'), b: side('b') };
}

async function main() {
  const args = pricingArgs(process.argv.slice(2));
  if (!args) {
    console.error(PRICING_USAGE);
    process.exit(2);
  }
  assertActiveLocalStack();
  const fail = (why) => {
    console.error(`merchant pricing: ${why}`);
    process.exit(3);
  };
  const ctx = { log: (m) => console.error(m) };
  let pair;
  try {
    pair = await founderPair(ctx);
  } catch (err) {
    fail(`the founder pair could not sign in (${err instanceof Error ? err.message : err})`);
  }
  const read = async (proc, input) => {
    const res = await pair.gctx.edge.query('pay', proc, input, pair.a.loginToken);
    const data = trpcData(res);
    if (data === undefined) fail(`${proc} refused: ${describeMoneyRefusal(pair.gates.refusalText(res))}`);
    return data;
  };
  const steps = [];
  const change = async (what, spec) => {
    const out = await founderChange(pair, spec);
    if (!out.ok) fail(`${what}: ${out.refusal}`);
    steps.push({ what, outcome: out.outcome });
  };

  const tier = journeyTier(args.merchantId, args.tier, args.payoutNotCharged);
  const tierPlan = planTierUpsert({ listed: await read('founderAdmin.control.tiers.list', {}), tier });
  if (tierPlan.kind === 'upsert') {
    const target = { scope: 'tier', change: { kind: 'upsert_tier', tier } };
    const reason = `LOCAL TEST: ${tier.name} for a journey business`;
    await change('tier', {
      submitProc: 'founderAdmin.control.configure.submit',
      confirmProc: 'founderAdmin.control.configure.confirm',
      input: {
        requestId: tierUpsertRequestId(tier, tierPlan.expectedVersion),
        change: target.change,
        reason,
        expectedVersion: tierPlan.expectedVersion,
      },
      target,
      expectedVersion: tierPlan.expectedVersion,
      reason,
    });
  } else steps.push({ what: 'tier', outcome: 'exists' });

  const wanted = journeyPricingRules(args.tier);
  const live = await read('founderAdmin.control.pricing.rules', { layer: 'tier', scopeId: tier.id });
  const layerPlan = planPricingLayer({ live, wanted });
  if (layerPlan.kind === 'set') {
    if (wanted.length === 0) fail(`${tier.id} holds a fee this run would have to remove; it is a blank tier only when it never had one`);
    const target = { scope: 'pricing', change: { kind: 'set_pricing_layer', layer: 'tier', scopeId: tier.id, rules: wanted } };
    const reason = `LOCAL TEST: TEST fee for ${tier.name}`;
    await change('fee', {
      submitProc: 'founderAdmin.control.configure.submit',
      confirmProc: 'founderAdmin.control.configure.confirm',
      input: {
        requestId: tierLayerRequestId(tier.id, layerPlan.expectedVersion),
        change: target.change,
        reason,
        expectedVersion: layerPlan.expectedVersion,
      },
      target,
      expectedVersion: layerPlan.expectedVersion,
      reason,
    });
  } else steps.push({ what: 'fee', outcome: 'exists' });

  const movePlan = planMove({ profile: await read('founderAdmin.control.merchant.get', { merchantId: args.merchantId }), tierId: tier.id });
  if (movePlan.kind === 'move') {
    const target = {
      scope: 'merchant',
      merchantId: args.merchantId,
      change: { kind: 'set_tier', tierId: tier.id, archetypeId: 'standard' },
    };
    const reason = `LOCAL TEST: put a journey business on ${tier.name}`;
    await change('move', {
      submitProc: 'founderAdmin.changes.submit',
      confirmProc: 'founderAdmin.changes.confirm',
      input: {
        requestId: tierMoveRequestId(args.merchantId, tier.id, movePlan.expectedVersion),
        merchantId: args.merchantId,
        change: target.change,
        reason,
        expectedVersion: movePlan.expectedVersion,
      },
      target,
      expectedVersion: movePlan.expectedVersion,
      reason,
    });
  } else steps.push({ what: 'move', outcome: 'exists' });

  const after = (await read('founderAdmin.control.tiers.list', {})).find((t) => t.id === tier.id);
  const profile = await read('founderAdmin.control.merchant.get', { merchantId: args.merchantId });
  console.log(
    JSON.stringify({
      merchantId: args.merchantId,
      tierId: tier.id,
      tierName: tier.name,
      tierVersion: after?.version ?? null,
      payoutFee: after?.payoutFee ?? null,
      onTier: profile?.tierId === tier.id,
      steps,
    }),
  );
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) await main();
