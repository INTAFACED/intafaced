import { describe, expect, it } from 'vitest';
import { parseAmount as amt } from '@intafaced/ledger-client';
import { normaliseReference, railMismatch } from './rail-validate.js';

const ORDER = { fiatCurrency: 'EUR', fiatAmount: amt('9.2'), reference: '0b6f1c1e-4a7d-4c55-9d1e-2f6f0e8a1b2c' };
const paid = (over: Partial<{ currency: string; amount: bigint; reference: string }> = {}) => ({
  confirmationId: 'TEST-1',
  currency: 'EUR',
  amount: amt('9.2'),
  reference: ORDER.reference,
  ...over,
});

describe('bank rail match (P-trade-orders-11)', () => {
  it('matches only the exact currency and amount', () => {
    expect(railMismatch(ORDER, paid())).toBeNull();
    expect(railMismatch(ORDER, paid({ currency: 'USD' }))).toBe('currency');
    expect(railMismatch(ORDER, paid({ amount: amt('9.19') }))).toBe('amount');
    expect(railMismatch(ORDER, paid({ amount: amt('9.21') }))).toBe('amount');
  });

  it('reads the order number as a bank renders it: case and separators aside, nothing else', () => {
    expect(railMismatch(ORDER, paid({ reference: ORDER.reference.toUpperCase() }))).toBeNull();
    expect(railMismatch(ORDER, paid({ reference: ORDER.reference.replace(/-/g, '') }))).toBeNull();
    expect(railMismatch(ORDER, paid({ reference: ORDER.reference.slice(0, 18) }))).toBe('reference');
    expect(railMismatch(ORDER, paid({ reference: 'another order' }))).toBe('reference');
    expect(normaliseReference(' ab-c 1 ')).toBe('ABC1');
  });
});
