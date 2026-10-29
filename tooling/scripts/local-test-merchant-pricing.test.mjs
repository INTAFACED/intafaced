// Proves, without starting or touching anything: the merchant-pricing script refuses bad arguments and anything outside
// the local test stack, and its planners only change what differs. Run: node --test tooling/scripts/local-test-merchant-pricing.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  JOURNEY_PRICING_RULE,
  journeyTier,
  planMove,
  planPricingLayer,
  planTierUpsert,
  pricingArgs,
  tierLayerRequestId,
  tierMoveRequestId,
  tierUpsertRequestId,
} from './local-test-merchant-pricing.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'local-test-merchant-pricing.mjs');
const MERCHANT = '1b2c3d4e-0000-4000-8000-000000000001';

test('arguments: a merchant id, one tier kind, an optional payout flag; anything else is refused', () => {
  assert.deepEqual(pricingArgs([MERCHANT, '--tier', 'priced']), { merchantId: MERCHANT, tier: 'priced', payoutNotCharged: false });
  assert.deepEqual(pricingArgs([MERCHANT.toUpperCase(), '--tier', 'blank', '--payout-not-charged']), {
    merchantId: MERCHANT,
    tier: 'blank',
    payoutNotCharged: true,
  });
  for (const argv of [
    [],
    ['not-a-uuid', '--tier', 'priced'],
    [MERCHANT],
    [MERCHANT, '--tier'],
    [MERCHANT, '--tier', 'charged'],
    [MERCHANT, '--tier', 'priced', '--tier', 'blank'],
    [MERCHANT, '--tier', 'priced', '--payout-not-charged', '--payout-not-charged'],
    [MERCHANT, '--tier', 'priced', '--payout-fee', '1'],
  ])
    assert.equal(pricingArgs(argv), null, JSON.stringify(argv));
});

test('the command refuses bad arguments with exit 2 and touches nothing', () => {
  const run = spawnSync(process.execPath, [SCRIPT, MERCHANT, '--tier', 'charged'], { encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /usage: local-test-merchant-pricing\.mjs/);
});

test('each business gets its own tier, off the shared ladder; only the flag publishes a payout fee, and only not_charged', () => {
  const priced = journeyTier(MERCHANT, 'priced', false);
  assert.equal(priced.id, 'j07-priced-1b2c3d4e');
  assert.ok(priced.id.length <= 32);
  assert.match(priced.name, /^TEST /);
  assert.equal(priced.merchantVisible, false);
  assert.equal('payoutFee' in priced, false);
  assert.deepEqual(journeyTier(MERCHANT, 'blank', true).payoutFee, { kind: 'not_charged' });
  assert.equal(journeyTier(MERCHANT, 'blank', true).id, 'j07-blank-1b2c3d4e');
});

test('a tier is written when missing or when any term differs, the payout fee included; an equal tier is left alone', () => {
  const tier = journeyTier(MERCHANT, 'priced', false);
  assert.deepEqual(planTierUpsert({ listed: [], tier }), { kind: 'upsert', expectedVersion: '0' });
  // The founder view prints amounts with trailing zeros and adds payoutFee null for an unpublished one.
  const view = {
    ...tier,
    caps: [
      { kind: 'beneficiaries_per_day', limit: 500 },
      { kind: 'daily_payout', assetCode: 'USDT', limit: '500.00' },
    ],
    approvalThresholds: [{ assetCode: 'USDT', amount: '10.0' }],
    payoutFee: null,
    version: '3',
  };
  assert.deepEqual(planTierUpsert({ listed: [view], tier }), { kind: 'exists', version: '3' });
  assert.deepEqual(planTierUpsert({ listed: [{ ...view, payoutFee: { kind: 'not_charged' } }], tier }), {
    kind: 'upsert',
    expectedVersion: '3',
  });
  const published = journeyTier(MERCHANT, 'priced', true);
  assert.deepEqual(planTierUpsert({ listed: [view], tier: published }), { kind: 'upsert', expectedVersion: '3' });
  assert.deepEqual(planTierUpsert({ listed: [{ ...view, payoutFee: { kind: 'not_charged' } }], tier: published }), {
    kind: 'exists',
    version: '3',
  });
  for (const drift of [
    { name: 'TEST other' },
    { merchantVisible: true },
    { approvalTtlSeconds: 60 },
    { caps: [{ kind: 'daily_payout', assetCode: 'USDT', limit: '501' }] },
    { founderThresholds: [{ assetCode: 'USDT', amount: '999' }] },
    { reserve: { rollingReserveBps: 100, holdDays: 7 } },
  ])
    assert.equal(planTierUpsert({ listed: [{ ...view, ...drift }], tier }).kind, 'upsert', JSON.stringify(drift));
});

test("a tier's fee layer is set only when its live rules differ, from the newest live rule's version", () => {
  const live = [
    {
      ...JOURNEY_PRICING_RULE,
      bands: [
        { fromAmount: '0.00', feeBps: 250, flatFee: null },
        { fromAmount: '10000', feeBps: 150, flatFee: '0.30' },
      ],
      minFee: '0.50',
      maxFee: null,
      version: '4',
    },
  ];
  assert.deepEqual(planPricingLayer({ live, wanted: [JOURNEY_PRICING_RULE] }), { kind: 'exists', version: '4' });
  assert.deepEqual(planPricingLayer({ live: [], wanted: [JOURNEY_PRICING_RULE] }), { kind: 'set', expectedVersion: '0' });
  assert.deepEqual(planPricingLayer({ live: [{ ...live[0], minFee: null }], wanted: [JOURNEY_PRICING_RULE] }), {
    kind: 'set',
    expectedVersion: '4',
  });
  assert.deepEqual(planPricingLayer({ live: [], wanted: [] }), { kind: 'exists', version: '0' });
  // A blank tier that holds a fee is a set the command refuses to make (a layer cannot be set to no rules).
  assert.equal(planPricingLayer({ live, wanted: [] }).kind, 'set');
});

test('a business is moved only when it is on another tier, from its profile version', () => {
  assert.deepEqual(planMove({ profile: { tierId: 'j07-priced-1b2c3d4e', version: '5' }, tierId: 'j07-priced-1b2c3d4e' }), {
    kind: 'exists',
    version: '5',
  });
  assert.deepEqual(planMove({ profile: { tierId: null, version: '0' }, tierId: 'j07-blank-1b2c3d4e' }), {
    kind: 'move',
    expectedVersion: '0',
  });
});

test('request ids are business keys: the same change from the same version repeats its id, any other change does not', () => {
  const tier = journeyTier(MERCHANT, 'priced', false);
  assert.equal(tierUpsertRequestId(tier, '1'), tierUpsertRequestId(tier, '1'));
  assert.notEqual(tierUpsertRequestId(tier, '1'), tierUpsertRequestId(tier, '2'));
  assert.notEqual(tierUpsertRequestId(tier, '1'), tierUpsertRequestId(journeyTier(MERCHANT, 'priced', true), '1'));
  assert.notEqual(tierLayerRequestId(tier.id, '0'), tierLayerRequestId(tier.id, '1'));
  assert.notEqual(tierMoveRequestId(MERCHANT, tier.id, '0'), tierMoveRequestId(MERCHANT, 'j07-blank-1b2c3d4e', '0'));
});
