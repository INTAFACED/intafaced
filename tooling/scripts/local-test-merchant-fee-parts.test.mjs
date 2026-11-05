// Proves, without starting or touching anything: the fee-parts script refuses bad arguments, its TEST rule is a
// percentage plus a flat amount with no clamp, and a second run with the rule live changes nothing.
// Run: node --test tooling/scripts/local-test-merchant-fee-parts.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { JOURNEY_FEE_PARTS_RULE, feePartsArgs, feePartsRequestId } from './local-test-merchant-fee-parts.mjs';
import { planPricingLayer } from './local-test-merchant-pricing.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'local-test-merchant-fee-parts.mjs');
const MERCHANT = '1b2c3d4e-0000-4000-8000-000000000001';

test('arguments: exactly one merchant id; anything else is refused', () => {
  assert.deepEqual(feePartsArgs([MERCHANT.toUpperCase()]), { merchantId: MERCHANT });
  for (const argv of [[], ['not-a-uuid'], [MERCHANT, MERCHANT], [MERCHANT, '--tier', 'priced']])
    assert.equal(feePartsArgs(argv), null, JSON.stringify(argv));
});

test('the command refuses bad arguments with exit 2 and touches nothing', () => {
  const run = spawnSync(process.execPath, [SCRIPT, 'not-a-uuid'], { encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /usage: local-test-merchant-fee-parts\.mjs/);
});

test('the TEST rule is 1.00% + 0.50 USDT from the first unit, with no minimum or maximum to clamp it', () => {
  assert.deepEqual(JOURNEY_FEE_PARTS_RULE.bands, [{ fromAmount: '0', feeBps: 100, flatFee: '0.5' }]);
  assert.equal(JOURNEY_FEE_PARTS_RULE.assetCode, 'USDT');
  assert.equal('minFee' in JOURNEY_FEE_PARTS_RULE, false);
  assert.equal('maxFee' in JOURNEY_FEE_PARTS_RULE, false);
});

test('a live rule equal to it is a noop; any other is set again from the newest version, with a business key', () => {
  const live = [
    {
      ...JOURNEY_FEE_PARTS_RULE,
      bands: [{ fromAmount: '0.000', feeBps: 100, flatFee: '0.500000' }],
      minFee: null,
      maxFee: null,
      version: '3',
    },
  ];
  assert.deepEqual(planPricingLayer({ live, wanted: [JOURNEY_FEE_PARTS_RULE] }), { kind: 'exists', version: '3' });
  assert.deepEqual(planPricingLayer({ live: [], wanted: [JOURNEY_FEE_PARTS_RULE] }), { kind: 'set', expectedVersion: '0' });
  assert.equal(feePartsRequestId(MERCHANT, '0'), feePartsRequestId(MERCHANT, '0'));
  assert.notEqual(feePartsRequestId(MERCHANT, '0'), feePartsRequestId(MERCHANT, '1'));
});
