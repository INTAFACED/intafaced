import { describe, expect, it } from 'vitest';
import { parseDirectDebits, parseRampMetrics } from './model';

const ramp = {
  label: 'TEST ramp',
  asOf: '2026-11-17T00:00:00.000Z',
  health: 'operational',
  lastOpenedAt: null,
  lastPaidAt: null,
  orders: [{ state: 'opened', count: 2 }],
  quoteExpiries: { count: 1, latest: [{ orderId: 'o', expiredAt: '2026-11-17T00:00:00.000Z' }] },
};
const dd = {
  label: 'TEST partner bank',
  asOf: '2026-11-17T00:00:00.000Z',
  mandates: [
    {
      mandateId: 'M',
      userId: 'u',
      state: 'blocked',
      blockedAt: '2026-11-17T00:00:00.000Z',
      knownAt: '2026-11-17T00:00:00.000Z',
      creditorName: null,
      reference: null,
      assetId: null,
      refunds: [],
      failures: [{ collectionId: 'c', code: 'x', at: '2026-11-17T00:00:00.000Z' }],
    },
  ],
  failuresByReason: [{ code: 'x', count: 1 }],
  refundCount: 0,
};

describe('the bank service desk reads (J-bank-28 #3 #4)', () => {
  it('no partner is no data, kept apart from a report of zero', () => {
    expect(parseRampMetrics({ partner: null })).toEqual({ partner: null });
    expect(parseDirectDebits({ partner: null })).toEqual({ partner: null });
  });
  it('reads the partner reports', () => {
    expect(parseRampMetrics({ partner: ramp })?.partner?.orders).toEqual([{ state: 'opened', count: 2 }]);
    expect(parseDirectDebits({ partner: dd })?.partner?.mandates[0]?.state).toBe('blocked');
  });
  it('refuses a shape it does not understand whole, never a guess', () => {
    expect(parseRampMetrics({})).toBeNull();
    expect(parseRampMetrics({ partner: { ...ramp, orders: [{ state: 'opened', count: -1 }] } })).toBeNull();
    expect(parseDirectDebits({ partner: { ...dd, mandates: [{ ...dd.mandates[0], state: 'frozen' }] } })).toBeNull();
  });
});
