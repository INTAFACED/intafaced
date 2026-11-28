import { describe, expect, it } from 'vitest';
import type { Context } from '@intafaced/contracts';
import { partial } from '@intafaced/service-kit/testing';
import { parseAmount } from '@intafaced/ledger-client';
import type { PayService } from './payment-service.js';
import { createPayRouter } from './router.js';
import { DEFAULT_SANDBOX_RAIL_ID, isSandboxRailId, paymentModeFromRail, resolveMerchantRail } from './sandbox-key-routing.js';
import type { UserMoneyService } from './user-money-service.js';
import { CHECKOUT_MERCHANT, scriptedCheckout } from './checkout-open.testkit.js';
import { CardSandboxAdapter } from './rails/card-sandbox.js';
import { MemoryChain } from './rails/chain-port.js';
import { CryptoNativeAdapter } from './rails/crypto-native.js';
import { selectPublicCheckoutRailDetailed } from './rails/posture.js';
import { RailRegistry } from './rails/registry.js';
import { REFERENCE_RAIL_ROUTING_PROFILES, selectSmartCheckoutRail, toRoutingDecisionRecord } from './routing/decide.js';
import { FORBIDDEN_ROUTING_SCORE_FIELDS } from './routing-inputs.js';

/**
 * Routing residual — no invent costs / approval rates (Nitro §8 blanks).
 *
 * Every routing answer this service produces (the smart route, its payment_events record, the public checkout's posture
 * walk and the record a checkout open writes) carries no cost or approval-rate field it made up, at any depth.
 * Behaviour of sandbox-key routing is covered in sandbox-key-routing.test.ts.
 */

function registry(): RailRegistry {
  return new RailRegistry([
    new CryptoNativeAdapter({
      chain: new MemoryChain(),
      secret: 'routing-crypto-test-secret-at-least-32',
      minConfirmations: 6,
      toleranceSeconds: 300,
    }),
    new CardSandboxAdapter({ secret: 'routing-no-invent-test-secret-at-least-32-chars', toleranceSeconds: 300 }),
  ]);
}

/** Every key at every depth of a value, so a score field nested in a considered entry is found too. */
function keysOf(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) for (const item of value) keysOf(item, out);
  else if (value !== null && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      out.push(key);
      keysOf(inner, out);
    }
  }
  return out;
}

const invented = (value: unknown) => keysOf(value).filter((key) => (FORBIDDEN_ROUTING_SCORE_FIELDS as readonly string[]).includes(key));

describe('routing — no invent costs or approval rates', () => {
  it('smart routing decisions and their payment_events record carry no invented cost or approval rate', () => {
    const preference = ['crypto-native', 'card-sandbox'];
    const declared = REFERENCE_RAIL_ROUTING_PROFILES.map((p) => ({ ...p, successRate: '0.90' }));
    const decisions = [
      selectSmartCheckoutRail({
        inputs: { geoCountry: 'DE', method: 'crypto', riskBand: 'low' },
        preference,
        profiles: declared,
        rails: registry(),
        policy: 'allow-sandbox',
      }),
      selectSmartCheckoutRail({
        inputs: { geoCountry: 'DE', method: 'card', riskBand: 'low' },
        preference,
        profiles: declared,
        rails: registry(),
        policy: 'allow-sandbox',
      }),
    ];
    for (const decision of decisions) {
      expect(invented(decision)).toEqual([]);
      const record = toRoutingDecisionRecord(decision);
      expect(record.kind).toBe('pay.routing.decision');
      expect(invented(record)).toEqual([]);
    }
  });

  it('the public checkout posture walk carries no score field', () => {
    for (const policy of ['allow-sandbox', 'live-only'] as const) {
      const decision = (() => {
        try {
          return selectPublicCheckoutRailDetailed(registry(), ['crypto-native', 'card-sandbox', 'not-registered'], policy);
        } catch (err) {
          return err;
        }
      })();
      expect(keysOf(decision).length).toBeGreaterThan(0);
      expect(invented(decision)).toEqual([]);
    }
  });

  it('the record a checkout open writes carries no invented score', async () => {
    const { pay, calls } = scriptedCheckout({ maxOpenSessionsPerLink: 25, checkoutSessionTtlSeconds: 900 });
    await pay.openCheckoutSession({ linkToken: 'pl_test_token', geoCountry: 'DE' }).catch(() => undefined);
    const selected = calls.filter((c) => c.text.includes('INSERT INTO pay.payment_events') && c.values.includes('rail.selected'));
    expect(selected).toHaveLength(1);
    expect(keysOf(selected[0]!.values)).toContain('chosenRailId');
    expect(invented(selected[0]!.values)).toEqual([]);
  });

  it('a payment create writes no invented score into its records', async () => {
    const { pay, calls } = scriptedCheckout({ maxOpenSessionsPerLink: 25, checkoutSessionTtlSeconds: 900 });
    await pay
      .createPayment({
        merchantId: CHECKOUT_MERCHANT,
        amount: parseAmount('10'),
        assetId: 'USDT',
        method: 'crypto',
        railAdapter: 'crypto-native',
      })
      .catch(() => undefined);
    const writes = calls.filter((c) => /^\s*(INSERT|UPDATE)\b/i.test(c.text));
    expect(writes.length).toBeGreaterThan(0);
    for (const write of writes) expect(invented(write.values), write.text.slice(0, 60)).toEqual([]);
  });

  it("the router's routing doors and the sandbox-key resolver answer with no score field", async () => {
    const router = createPayRouter(partial<PayService>({}), registry(), partial<UserMoneyService>({}));
    const ctx: Context = { principal: null, service: null, region: 'DE', requestId: 'routing-no-invent' };
    const caller = router.createCaller(ctx);
    const policy = await caller.routing.policy();
    expect(keysOf(policy).length).toBeGreaterThan(0);
    expect(invented(policy)).toEqual([]);
    const asserted = await caller.routing.assertInputs({
      required: ['geo', 'method', 'risk'],
      geoCountry: 'DE',
      method: 'card',
      riskBand: 'low',
    });
    expect(invented(asserted)).toEqual([]);
    const refused = await caller.routing.assertInputs({ required: ['geo'] }).catch((err: unknown) => err);
    expect(invented(refused)).toEqual([]);

    // The sandbox-key resolver answers with a rail id or a mode, never a scored choice.
    const answers = [
      resolveMerchantRail({ keyEnv: 'sandbox', requestedRail: 'crypto-native' }),
      resolveMerchantRail({ keyEnv: 'live', requestedRail: 'crypto-native' }),
      paymentModeFromRail(DEFAULT_SANDBOX_RAIL_ID),
      isSandboxRailId('crypto-native'),
    ];
    for (const answer of answers) expect(['string', 'boolean']).toContain(typeof answer);
  });
});
