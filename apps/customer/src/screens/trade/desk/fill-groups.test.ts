import { describe, expect, it } from 'vitest';
import type { Trade } from '@intafaced/exchange-contract/schemas';
import { groupFillsByOrder } from './fill-groups';

// TEST DATA written for these tests.
const fill = (id: string, order: string | null, timestamp: number, amount: string, cost: string, fee: Trade['fee'] = null): Trade => ({
  id,
  order,
  timestamp,
  datetime: new Date(timestamp).toISOString(),
  symbol: 'BTC/USDT',
  type: null,
  side: 'sell',
  takerOrMaker: 'maker',
  price: '1',
  amount,
  cost,
  fee,
});

describe('groupFillsByOrder', () => {
  it('puts the fills of one order together, newest group first, and adds them up exactly', () => {
    const groups = groupFillsByOrder([
      fill('a', 'o1', 1, '0.001', '65.1', { cost: '0.0651', currency: 'USDT', rate: '0.001' }),
      fill('b', 'o2', 2, '0.004', '261.2'),
      fill('c', 'o1', 3, '0.001', '65.3', { cost: '0.0653', currency: 'USDT', rate: '0.001' }),
    ]);
    expect(groups.map((g) => [g.order, g.fills.map((f) => f.id)])).toEqual([
      ['o1', ['c', 'a']],
      ['o2', ['b']],
    ]);
    expect(groups[0]).toMatchObject({ amount: '0.002', cost: '130.4', average: '65200', fee: { cost: '0.1304', currency: 'USDT' } });
    expect(groups[1]).toMatchObject({ amount: '0.004', cost: '261.2', average: '65300', fee: null });
  });

  it('keeps a fill with no order on its own, and adds no fee across coins', () => {
    const groups = groupFillsByOrder([
      fill('a', null, 1, '1', '2'),
      fill('b', null, 2, '1', '2'),
      fill('c', 'o1', 3, '1', '2', { cost: '0.1', currency: 'BTC', rate: null }),
      fill('d', 'o1', 4, '1', '2', { cost: '0.2', currency: 'USDT', rate: null }),
    ]);
    expect(groups.map((g) => g.fills.length)).toEqual([2, 1, 1]);
    expect(groups[0]!.fee).toBeNull();
  });

  it('adds the fees of the fills that paid one, and has none when no fill paid', () => {
    const [paidSome] = groupFillsByOrder([
      fill('a', 'o', 1, '1', '2', { cost: '0.1', currency: 'USDT', rate: null }),
      fill('b', 'o', 2, '1', '2'),
    ]);
    expect(paidSome!.fee).toEqual({ cost: '0.1', currency: 'USDT' });
    const [paidNone] = groupFillsByOrder([fill('a', 'o', 1, '1', '2'), fill('b', 'o', 2, '1', '2')]);
    expect(paidNone!.fee).toBeNull();
  });

  it('rounds the average half-up', () => {
    expect(groupFillsByOrder([fill('a', 'o', 1, '3', '2')])[0]!.average).toBe('0.666666666666666667');
  });

  it('has no average for an amount of zero', () => {
    expect(groupFillsByOrder([fill('a', 'o', 1, '0', '0')])[0]!.average).toBeNull();
  });
});
