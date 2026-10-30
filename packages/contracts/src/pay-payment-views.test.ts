import { describe, expect, it } from 'vitest';
import { PAYMENT_UNMASK_REASON_MIN, paymentUnmaskInputSchema } from './pay-payment-views.js';

const paymentId = '00000000-0000-4000-8000-000000000001';

describe('payment unmask input (M-adv-payments-core-01)', () => {
  it('lets a missing or short reason through, so svc-pay refuses it with its own typed code', () => {
    for (const reason of ['', '  short ', 'x'.repeat(PAYMENT_UNMASK_REASON_MIN - 1)]) {
      expect(paymentUnmaskInputSchema.safeParse({ paymentId, field: 'customerEmail', reason }).success).toBe(true);
    }
  });

  it('trims the reason and still refuses one over 500 characters or an unknown field', () => {
    expect(paymentUnmaskInputSchema.parse({ paymentId, field: 'customerEmail', reason: '  TEST reason  ' }).reason).toBe('TEST reason');
    expect(paymentUnmaskInputSchema.safeParse({ paymentId, field: 'customerEmail', reason: 'x'.repeat(501) }).success).toBe(false);
    expect(paymentUnmaskInputSchema.safeParse({ paymentId, field: 'railRef', reason: 'TEST reason here' }).success).toBe(false);
  });
});
