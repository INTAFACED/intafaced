#!/usr/bin/env node
/**
 * LOCAL TEST merchant fee in two parts — gives one TEST business a merchant-layer USDT fee of a percentage plus a flat
 * amount (JOURNEY_FEE_PARTS_RULE), through svc-pay's own two-founder door, so a journey can read a stored fee in its
 * parts (J-merchant-05 #5: a 100 USDT payment pays a TEST fee of 1.50, its 1.00 percentage part and 0.50 flat part).
 * Local only.
 *
 *   node tooling/scripts/local-test-merchant-fee-parts.mjs <merchantId>
 *
 * One founder submits founderAdmin.control.configure (set_pricing_layer, layer merchant, the business's id) and a
 * DIFFERENT founder confirms with the hash of the change they were shown: the stack's enrolled LOCAL TEST founders, or
 * the two TEST operators on a stack without them (local-test-gates' approverSessions). Nothing is written to a table.
 * The rule belongs to this business only. A run reads the business's merchant layer first and only changes it when it
 * differs, so a second run is a noop. Prints JSON.
 *
 * Every figure here is a TEST VALUE for the local stack, not a proposal for a real price.
 */
import { assertActiveLocalStack } from './local-test-state.mjs';
import { describeMoneyRefusal, founderChange, populateUuid, trpcData } from './local-test-world.mjs';
import { planPricingLayer } from './local-test-merchant-pricing.mjs';

export const FEE_PARTS_USAGE = 'usage: local-test-merchant-fee-parts.mjs <merchantId>';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** TEST VALUE merchant-layer fee: 1.00% + 0.50 USDT on every payment, no minimum or maximum; the platform keeps fractions. */
export const JOURNEY_FEE_PARTS_RULE = {
  assetCode: 'USDT',
  bands: [{ fromAmount: '0', feeBps: 100, flatFee: '0.5' }],
  spreadBps: null,
  roundingBeneficiary: 'platform',
};

/** The merchant id, lower-cased, or null. Everything is refused before the stack is touched. */
export function feePartsArgs(argv) {
  if (argv.length !== 1 || !UUID.test(String(argv[0] ?? ''))) return null;
  return { merchantId: argv[0].toLowerCase() };
}

/**
 * Whether the merchant layer must be set, and from which version. svc-pay versions a merchant-layer pricing change by the
 * merchant's control profile (`founderAdmin.control.merchant.get` version, control/changes.ts pricingVersion), not by its
 * rules: a tier move bumps it, so the rules' own versions would end the change `conflict`.
 */
export function feePartsPlan({ live, profile }) {
  const same = planPricingLayer({ live, wanted: [JOURNEY_FEE_PARTS_RULE] }).kind === 'exists';
  const version = String(profile?.version ?? '0');
  return same ? { kind: 'exists', version } : { kind: 'set', expectedVersion: version };
}

/** Request ids are business keys: the same change from the same version is the same request. */
export const feePartsRequestId = (merchantId, expectedVersion) => populateUuid(`journey-fee-parts-${merchantId}-v${expectedVersion}`);

async function founderPair(log) {
  const gates = await import('./local-test-gates.mjs');
  const gctx = await gates.makeContext({ log: (m) => log(`merchant fee parts founders: ${m}`) });
  const sessions = await gates.approverSessions(gctx);
  const side = (letter) => ({ letter, loginToken: sessions[letter].token });
  return { ok: true, gates, gctx, a: side('a'), b: side('b') };
}

async function main() {
  const args = feePartsArgs(process.argv.slice(2));
  if (!args) {
    console.error(FEE_PARTS_USAGE);
    process.exit(2);
  }
  assertActiveLocalStack();
  const fail = (why) => {
    console.error(`merchant fee parts: ${why}`);
    process.exit(3);
  };
  let pair;
  try {
    pair = await founderPair((m) => console.error(m));
  } catch (err) {
    fail(`the founder pair could not sign in (${err instanceof Error ? err.message : err})`);
  }
  const read = async (proc, input) => {
    const res = await pair.gctx.edge.query('pay', proc, input, pair.a.loginToken);
    const data = trpcData(res);
    if (data === undefined) fail(`${proc} refused: ${describeMoneyRefusal(pair.gates.refusalText(res))}`);
    return data;
  };
  const scope = { layer: 'merchant', scopeId: args.merchantId };
  const plan = feePartsPlan({
    live: await read('founderAdmin.control.pricing.rules', scope),
    profile: await read('founderAdmin.control.merchant.get', { merchantId: args.merchantId }),
  });
  let outcome = 'exists';
  if (plan.kind === 'set') {
    const target = { scope: 'pricing', change: { kind: 'set_pricing_layer', ...scope, rules: [JOURNEY_FEE_PARTS_RULE] } };
    const reason = 'LOCAL TEST: a TEST fee in two parts for a journey business';
    const out = await founderChange(pair, {
      submitProc: 'founderAdmin.control.configure.submit',
      confirmProc: 'founderAdmin.control.configure.confirm',
      input: {
        requestId: feePartsRequestId(args.merchantId, plan.expectedVersion),
        change: target.change,
        reason,
        expectedVersion: plan.expectedVersion,
      },
      target,
      expectedVersion: plan.expectedVersion,
      reason,
    });
    if (!out.ok) fail(`fee: ${out.refusal}`);
    outcome = out.outcome;
  }
  const live = await read('founderAdmin.control.pricing.rules', scope);
  console.log(
    JSON.stringify({
      merchantId: args.merchantId,
      outcome,
      rules: live.length,
      holds: planPricingLayer({ live, wanted: [JOURNEY_FEE_PARTS_RULE] }).kind === 'exists',
    }),
  );
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) await main();
