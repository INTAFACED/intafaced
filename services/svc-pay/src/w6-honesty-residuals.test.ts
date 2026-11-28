import { describe, expect, it } from 'vitest';
import { scriptedCheckout, wrotePayment, wroteSession } from './checkout-open.testkit.js';
import { PAY_KYB_REQUIRED_CODE } from './merchant-kyb-money-gate.js';

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
});
