import { describe, expect, it } from 'vitest';
import { failureCatalog } from './merchant-failure.js';
import { PAYMENT_STATUSES, plainPaymentState } from './payment-plain-state.js';

describe('plainPaymentState', () => {
  it('every status maps to a capitalised plain label and a sentence', () => {
    for (const status of PAYMENT_STATUSES) {
      const s = plainPaymentState({ status });
      expect(s.label).toMatch(/^[A-Z][a-z ,]+$/);
      expect(s.label).not.toBe(status);
      expect(s.sentence.length).toBeGreaterThan(0);
    }
  });
  it('created with a chain transfer shows waiting for confirmations with the count', () => {
    expect(plainPaymentState({ status: 'created', chainTransfer: { confirmations: 2, required: 6 } })).toMatchObject({
      label: 'Waiting for confirmations',
      confirmations: { seen: 2, required: 6 },
    });
  });
  it('unknown counts give no invented numbers', () => {
    expect(plainPaymentState({ status: 'created', chainTransfer: { confirmations: 2, required: null } }).confirmations).toBeUndefined();
  });
  it('created with nothing seen needs customer action; authorized is authorised not captured', () => {
    expect(plainPaymentState({ status: 'created' }).key).toBe('needs_customer_action');
    expect(plainPaymentState({ status: 'authorized' }).key).toBe('authorised_not_captured');
  });
  it('an unknown rail outcome shows checking with the rail, never failed', () => {
    expect(plainPaymentState({ status: 'authorized', railOutcomeUnknown: true }).key).toBe('checking_with_rail');
    expect(plainPaymentState({ status: 'created', railOutcomeUnknown: true }).key).toBe('checking_with_rail');
  });
  it('failed uses the catalogue sentence; unknown codes collapse with no provider text', () => {
    expect(plainPaymentState({ status: 'failed', failureReason: 'chain.underpaid' }).sentence).toBe(
      'The transfer was less than the amount due.',
    );
    const u = plainPaymentState({ status: 'failed', failureReason: 'PROVIDER: boom 0x12' });
    expect(u.failure).toEqual({ code: 'pay.failed', message: 'The payment could not be completed.' });
    expect(JSON.stringify(u)).not.toContain('boom');
    expect(plainPaymentState({ status: 'failed' }).failure?.code).toBe('pay.failed');
  });
});

describe('failureCatalog', () => {
  it('lists every code once, sorted, each with a sentence', () => {
    const c = failureCatalog();
    const codes = c.map((f) => f.code);
    expect(codes).toEqual([...codes].sort());
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes).toContain('chain.underpaid');
    expect(c.every((f) => f.message.length > 0)).toBe(true);
  });
});
