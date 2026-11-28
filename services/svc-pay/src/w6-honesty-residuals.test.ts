import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client';
import { CHECKOUT_MERCHANT, scriptedCheckout, wrotePayment, wroteSession } from './checkout-open.testkit.js';
import { PAY_KYB_REQUIRED_CODE } from './merchant-kyb-money-gate.js';
import { issueMerchantPayScopesViaGrantPath } from './merchant-pay-grant-path.js';
import { PayService } from './payment-service.js';

// Layer A grant issuance belongs to @intafaced/auth and is reached only through merchant-pay-grant-path.ts: the two
// grant functions are recorded (and still run) so a PayService path that issues pay:* scopes is seen.
const grants = vi.hoisted(() => ({ issue: [] as unknown[], assert: [] as unknown[] }));
vi.mock('@intafaced/auth', async (importOriginal) => {
  const auth = await importOriginal<typeof import('@intafaced/auth')>();
  return {
    ...auth,
    issueMerchantPayScopes: (...args: Parameters<typeof auth.issueMerchantPayScopes>) => {
      grants.issue.push(args);
      return auth.issueMerchantPayScopes(...args);
    },
    assertMerchantPayScopeGrantAllowed: (...args: Parameters<typeof auth.assertMerchantPayScopeGrantAllowed>) => {
      grants.assert.push(args);
      return auth.assertMerchantPayScopeGrantAllowed(...args);
    },
  };
});

/**
 * Wave 6 honesty pins — promises that are true-as-gap, not true-as-product.
 * Each test fails when someone "quietly" wires or invents the missing half.
 *
 * The webhook door's dispute and refund branches are driven in payment-service.test.ts ("dispute.opened posts
 * chargebackOpen from clearing and marks disputed", "records a refund webhook without acting on it"); every dispute
 * post being exactly its ledger-client recipe is chargeback-unwired.test.ts.
 */

const open = (pay: ReturnType<typeof scriptedCheckout>['pay']) => pay.openCheckoutSession({ linkToken: 'pl_test_token', geoCountry: 'DE' });

// The money gate is the integration path's (`valueMovement`); the public page's rail gate stays open to the TEST rail.
const OPEN = { maxOpenSessionsPerLink: 25, checkoutSessionTtlSeconds: 900 } as const;
const LIVE = { ...OPEN, valueMovement: 'live-only', publicCheckoutMovement: 'allow-sandbox' } as const;

describe('W6 honesty residuals', () => {
  it('assertMerchantActive wires Layer B KYB money gate (D26-P1-P10) without inventing grants', async () => {
    // Live acquiring must require approved KYB; Layer A grant issuance stays refuse-closed in @intafaced/auth.
    for (const kyb_status of ['pending', 'none', 'rejected']) {
      const { pay, calls } = scriptedCheckout(LIVE, { merchant: { kyb_status } });
      await expect(open(pay)).rejects.toMatchObject({ code: PAY_KYB_REQUIRED_CODE, detail: { kybStatus: kyb_status } });
      expect(wroteSession(calls)).toBe(false);
      expect(wrotePayment(calls)).toBe(false);
    }
    // A rejected merchant cannot transact on sandbox either; a pending one may, on sandbox only.
    const rejected = scriptedCheckout({ ...OPEN, valueMovement: 'allow-sandbox' }, { merchant: { kyb_status: 'rejected' } });
    await expect(open(rejected.pay)).rejects.toMatchObject({ code: PAY_KYB_REQUIRED_CODE });
    expect(wrotePayment(rejected.calls)).toBe(false);
    const pending = scriptedCheckout({ ...OPEN, valueMovement: 'allow-sandbox' }, { merchant: { kyb_status: 'pending' } });
    // Past the gate: the payment row is written (the scripted database answers no further).
    await open(pending.pay).catch(() => undefined);
    expect(wrotePayment(pending.calls)).toBe(true);
    // An approved live merchant passes the gate; a suspended one is refused before it.
    const approved = scriptedCheckout(LIVE, { merchant: { kyb_status: 'approved' } });
    // Past the gate: the payment row is written (the scripted database answers no further).
    await open(approved.pay).catch(() => undefined);
    expect(wrotePayment(approved.calls)).toBe(true);
    const suspended = scriptedCheckout(LIVE, { merchant: { status: 'suspended' } });
    await expect(open(suspended.pay)).rejects.toMatchObject({ code: 'pay.merchant_inactive' });
    expect(wrotePayment(suspended.calls)).toBe(false);
  });

  afterEach(() => {
    grants.issue.length = 0;
    grants.assert.length = 0;
  });

  it('PayService never issues pay:* scopes: no merchant path calls the auth grant functions', async () => {
    // The recorder sees the grant path itself, so a quiet result below is the service's, not a mock that missed.
    expect(() =>
      issueMerchantPayScopesViaGrantPath({
        merchantId: CHECKOUT_MERCHANT,
        ownedMerchantId: CHECKOUT_MERCHANT,
        scopes: ['pay:read'],
        kybStatus: 'pending',
        merchantStatus: 'active',
        actorUserId: 'merchant-user',
        ownerUserId: 'merchant-user',
        role: 'owner',
      }),
    ).toThrow();
    expect(grants.issue.length + grants.assert.length).toBeGreaterThan(0);
    grants.issue.length = 0;
    grants.assert.length = 0;

    const actor = { id: 'operator-1', scope: 'admin:kyb' };
    for (const kyb_status of ['none', 'pending', 'approved', 'rejected']) {
      for (const movement of [LIVE, { ...OPEN, valueMovement: 'allow-sandbox' } as const]) {
        const { pay } = scriptedCheckout(movement, { merchant: { kyb_status } });
        const paths: Array<() => Promise<unknown>> = [
          () => pay.createMerchant({ userId: 'merchant-user', pricing: { feeBps: 100 } }),
          () => pay.getMerchant(CHECKOUT_MERCHANT),
          () => pay.getMerchantByUserId('merchant-user'),
          () => pay.submitKyb({ merchantId: CHECKOUT_MERCHANT, kybRef: 'kyb-ref-1', actor }),
          () => pay.decideKyb({ merchantId: CHECKOUT_MERCHANT, decision: 'approved', identityHash: 'hash-1', actor }),
          () => pay.decideKybStub({ merchantId: CHECKOUT_MERCHANT, decision: 'approved', actor }),
          () => open(pay),
          () => pay.createPaymentLink({ merchantId: CHECKOUT_MERCHANT, label: 'TEST link', amount: parseAmount('10'), currency: 'USDT' }),
          () =>
            pay.createPayment({
              merchantId: CHECKOUT_MERCHANT,
              amount: parseAmount('10'),
              assetId: 'USDT',
              method: 'crypto',
              railAdapter: 'crypto-native',
            }),
        ];
        for (const path of paths) await path().catch(() => undefined);
      }
    }
    // Every other method the service exposes, called once with merchant-shaped input.
    const { pay } = scriptedCheckout(LIVE);
    const input = { merchantId: CHECKOUT_MERCHANT, userId: 'merchant-user', paymentId: CHECKOUT_MERCHANT, limit: 10 };
    for (const name of Object.getOwnPropertyNames(PayService.prototype)) {
      const method: unknown = Object.getOwnPropertyDescriptor(PayService.prototype, name)?.value;
      if (name === 'constructor' || typeof method !== 'function') continue;
      await Promise.resolve()
        .then(() => method.call(pay, input, input))
        .catch(() => undefined);
    }
    expect(grants.issue).toEqual([]);
    expect(grants.assert).toEqual([]);
  });
});
