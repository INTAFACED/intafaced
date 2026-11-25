import { describe, expect, it } from 'vitest';
import type { VenueFill, VenueOrder } from '../venue-api';
import { fillTotal, groupVenueFillsByOrder, readAllVenueOrders } from './venue-fill-groups';

const fill = (patch: Partial<VenueFill>): VenueFill => ({
  fillId: 'f1',
  venueClientOrderId: '0xorder1',
  symbol: 'BTC-USDC',
  side: 'buy',
  price: '60000',
  amount: '0.001',
  role: 'maker',
  venueFee: '0.03',
  builderFee: '0.01',
  feeAsset: 'USDC',
  realisedPnl: null,
  filledAt: '2026-11-24T10:00:00.000Z',
  ...patch,
});

describe('groupVenueFillsByOrder (J-portfolio-03 #5)', () => {
  it('groups partial fills of one order newest first with exact amount, total, weighted average price and summed fees', () => {
    const groups = groupVenueFillsByOrder([
      fill({ fillId: 'f1', price: '60000', amount: '0.001', venueFee: '0.03', builderFee: '0.01', filledAt: '2026-11-24T10:00:00.000Z' }),
      fill({
        fillId: 'f3',
        venueClientOrderId: '0xother',
        price: '61000',
        amount: '0.002',
        venueFee: '0',
        builderFee: '0',
        filledAt: '2026-11-24T10:01:00.000Z',
      }),
      fill({ fillId: 'f2', price: '62000', amount: '0.003', venueFee: '0.09', builderFee: '0.03', filledAt: '2026-11-24T10:02:00.000Z' }),
    ]);

    expect(groups.map((g) => [g.order, g.fills.map((f) => f.fillId)])).toEqual([
      ['0xorder1', ['f2', 'f1']],
      ['0xother', ['f3']],
    ]);
    // 0.001 * 60000 = 60; 0.003 * 62000 = 186; total = 246; amount = 0.004; average = 246 / 0.004 = 61500.
    expect(groups[0]).toMatchObject({
      amount: '0.004',
      total: '246',
      average: '61500',
      feeAsset: 'USDC',
      venueFee: '0.12',
      builderFee: '0.04',
      realisedPnl: null,
    });
    expect(fillTotal(groups[1]!.fills[0]!)).toBe('122');
  });

  it('preserves negative rebates and never sums fees across different fee assets', () => {
    const rebate = groupVenueFillsByOrder([
      fill({ fillId: 'r1', venueFee: '-0.02', builderFee: '0', realisedPnl: '-1.5', filledAt: '2026-11-24T10:00:00.000Z' }),
      fill({ fillId: 'r2', venueFee: '-0.03', builderFee: '0', realisedPnl: '0.5', filledAt: '2026-11-24T10:01:00.000Z' }),
    ]);
    expect(rebate[0]).toMatchObject({ venueFee: '-0.05', builderFee: '0', realisedPnl: '-1', feeAsset: 'USDC' });

    const mixed = groupVenueFillsByOrder([fill({ fillId: 'm1', feeAsset: 'USDC' }), fill({ fillId: 'm2', feeAsset: 'BTC' })]);
    expect(mixed[0]).toMatchObject({ feeAsset: null, venueFee: null, builderFee: null, realisedPnl: null });
  });

  it('keeps fills with no venueClientOrderId in separate single-fill groups', () => {
    const groups = groupVenueFillsByOrder([
      fill({ fillId: 'n1', venueClientOrderId: null, filledAt: '2026-11-24T10:00:00.000Z' }),
      fill({ fillId: 'n2', venueClientOrderId: null, filledAt: '2026-11-24T10:01:00.000Z' }),
    ]);
    expect(groups.map((g) => g.fills.map((f) => f.fillId))).toEqual([['n2'], ['n1']]);
  });
});

describe('readAllVenueOrders', () => {
  const sampleOrder = (id: string): VenueOrder => ({
    venueOrderId: id,
    venueClientOrderId: id,
    symbol: 'BTC-USDC',
    side: 'buy',
    type: 'limit',
    timeInForce: 'GTC',
    price: '60000',
    amount: '0.001',
    filled: '0',
    remaining: '0.001',
    averagePrice: null,
    status: 'open',
    locked: '60',
    lockedAsset: 'USDC',
    reduceOnly: false,
  });

  it('follows pagination cursors until next is null', async () => {
    const pages = [
      { orders: [{ order: sampleOrder('0x1'), placedAt: '2026-11-24T10:02:00.000Z' }], next: '0x1', asOf: '2026-11-24T10:03:00.000Z' },
      { orders: [{ order: sampleOrder('0x2'), placedAt: '2026-11-24T10:01:00.000Z' }], next: null, asOf: '2026-11-24T10:03:00.000Z' },
    ];
    let calls = 0;
    const res = await readAllVenueOrders(
      {
        orderHistory: async (_owner, q) => {
          const page = pages[calls++]!;
          if (calls === 2) expect(q.before).toBe('0x1');
          return { ok: true, data: page };
        },
        openOrders: async () => {
          throw new Error('should not call openOrders');
        },
      },
      '0xabc',
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.map((e) => e.order.venueClientOrderId)).toEqual(['0x1', '0x2']);
  });

  it('falls back to openOrders when orderHistory is not_offered', async () => {
    const res = await readAllVenueOrders(
      {
        orderHistory: async () => ({ ok: false, reason: 'error', status: 422, code: 'not_offered', message: 'not offered' }),
        openOrders: async () => ({
          ok: true,
          data: { venueId: 'v', value: [sampleOrder('0xopen')], asOf: '2026-11-24T10:03:00.000Z' },
        }),
      },
      '0xabc',
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.map((e) => [e.order.venueClientOrderId, e.placedAt])).toEqual([['0xopen', '2026-11-24T10:03:00.000Z']]);
  });
});
