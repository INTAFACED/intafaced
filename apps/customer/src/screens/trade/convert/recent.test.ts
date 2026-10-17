import { describe, expect, it } from 'vitest';
import type { ActivityItem } from './deps';
import { recentConversions } from './recent';

let n = 0;
const line = (over: Partial<ActivityItem>): ActivityItem => ({
  id: `i${++n}`,
  kind: 'trade',
  direction: 'out',
  asset: 'USDT',
  amount: '1',
  postedAt: '2026-10-17T10:00:00.000Z',
  txId: `t${n}`,
  counterparty: null,
  spaceName: null,
  ...over,
});

describe('recentConversions', () => {
  it('groups the two trade lines of one order and keeps exact decimal strings', () => {
    const rows = recentConversions([
      line({ orderId: 'o1', direction: 'in', asset: 'ETH', amount: '0.123456789012345678' }),
      line({ orderId: 'o1', direction: 'out', asset: 'USDT', amount: '320.10', postedAt: '2026-10-17T10:00:01.000Z' }),
    ]);
    expect(rows).toEqual([
      {
        id: 'o1',
        fromAsset: 'USDT',
        fromAmount: '320.10',
        toAsset: 'ETH',
        toAmount: '0.123456789012345678',
        at: '2026-10-17T10:00:01.000Z',
      },
    ]);
  });
  it('skips lines without an order id, spot orders with holds or fees, and one-sided orders', () => {
    const rows = recentConversions([
      line({ direction: 'out' }),
      line({ direction: 'in', asset: 'ETH' }),
      line({ orderId: 'o2', direction: 'out' }),
      line({ orderId: 'o2', direction: 'in', asset: 'ETH' }),
      line({ orderId: 'o2', kind: 'fee' }),
      line({ orderId: 'o3', direction: 'out' }),
      line({ orderId: 'o4', kind: 'deposit', direction: 'in', asset: 'ETH' }),
      line({ orderId: 'o4', direction: 'out' }),
    ]);
    expect(rows).toEqual([]);
  });
  it('lists newest first and honours the limit', () => {
    const pair = (id: string, at: string) => [
      line({ orderId: id, direction: 'out', postedAt: at }),
      line({ orderId: id, direction: 'in', asset: 'ETH', postedAt: at }),
    ];
    const rows = recentConversions(
      [...pair('a', '2026-10-17T09:00:00Z'), ...pair('b', '2026-10-17T11:00:00Z'), ...pair('c', '2026-10-17T10:00:00Z')],
      2,
    );
    expect(rows.map((r) => r.id)).toEqual(['b', 'c']);
  });
});
