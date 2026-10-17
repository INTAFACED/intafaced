import { expect, it } from 'vitest';
import { recompute, assertProjection, type Sources } from './oracle.js';

it('independently attributes refunds to capture day, separates assets/merchants and counts statuses', () => {
  const day = new Date('2026-01-01T23:59:59Z');
  const later = new Date('2026-01-02T00:01:00Z');
  const source: Sources = {
    payments: [
      { id: 'a', merchant_id: 'PSP TEST DATA', currency: 'USD', status: 'settled', created_at: day },
      { id: 'b', merchant_id: 'broker TEST DATA', currency: 'BTC', status: 'captured', created_at: later },
    ],
    events: [
      { payment_id: 'a', event: 'captured', payload: { amount: '100.25' }, ts: day },
      { payment_id: 'b', event: 'captured', payload: { amount: '0.1' }, ts: later },
      { payment_id: 'a', event: 'refunded', payload: { amount: '10.01' }, ts: later },
    ],
    settlements: [
      { merchant_id: 'PSP TEST DATA', asset_id: 'USD', status: 'paid_out', gross: '90.24', fees: '0', net: '90.24', created_at: later },
    ],
    sessions: [],
  };
  const result = recompute(source);
  const pspCapture = result.days.find((r) => r.merchantId === 'PSP TEST DATA' && r.day === '2026-01-01')!;
  expect(pspCapture).toMatchObject({
    captured: 100250000000000000000n,
    refunded: 10010000000000000000n,
    capturedCount: 1,
    refundedCount: 1,
  });
  expect(result.days.find((r) => r.merchantId === 'broker TEST DATA')).toMatchObject({
    captured: 100000000000000000n,
    unsettledNet: 100000000000000000n,
  });
  expect(result.days.find((r) => r.merchantId === 'PSP TEST DATA' && r.day === '2026-01-02')).toMatchObject({
    settleNet: 90240000000000000000n,
  });
  expect(() => assertProjection(result, result)).not.toThrow();
  expect(() => assertProjection(result, { ...result, days: result.days.map((r) => ({ ...r, captured: r.captured + 1n })) })).toThrow(
    /metrics drift/,
  );
  expect(() => assertProjection(result, { ...result, statuses: [] })).toThrow(/metrics drift/);
});
