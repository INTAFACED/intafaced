import { describe, expect, it } from 'vitest';
import { paymentIsSettled } from '../scripts/card-sandbox-settled-list.mjs';

const PAYMENT_ID = 'pay_list_target';

describe('paymentIsSettled', () => {
  it('is true when the list contains the payment id', () => {
    expect(paymentIsSettled([{ id: PAYMENT_ID }, { id: 'pay_other' }], PAYMENT_ID)).toBe(true);
  });

  it('is false when the list omits the payment id', () => {
    expect(paymentIsSettled([{ id: 'pay_other' }], PAYMENT_ID)).toBe(false);
    expect(paymentIsSettled([], PAYMENT_ID)).toBe(false);
  });

  it('is false when the only row is a different id with status captured', () => {
    expect(paymentIsSettled([{ id: 'pay_other', status: 'captured' }], PAYMENT_ID)).toBe(false);
  });

  it('is false when listed is not an array', () => {
    expect(paymentIsSettled(null, PAYMENT_ID)).toBe(false);
    expect(paymentIsSettled(undefined, PAYMENT_ID)).toBe(false);
    expect(paymentIsSettled({ id: PAYMENT_ID }, PAYMENT_ID)).toBe(false);
  });
});
