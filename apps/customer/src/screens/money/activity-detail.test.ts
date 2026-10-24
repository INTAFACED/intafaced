import { describe, expect, it } from 'vitest';
import { detailHref, findGroup, idFromPath, sharedOrder } from './activity-detail';
import type { ActivityItem } from './deps';

const item = (over: Partial<ActivityItem>): ActivityItem => ({
  id: 'l1',
  kind: 'transfer_in',
  direction: 'in',
  asset: 'USDT',
  amount: '5',
  postedAt: '2026-10-10T12:00:00Z',
  txId: 'tx1',
  counterparty: null,
  spaceName: null,
  ...over,
});

describe('transaction page address', () => {
  it('round-trips a row id that contains a colon', () => {
    const href = detailHref({ id: 'order:abc-1' });
    expect(href).toBe('/money/activity/order%3Aabc-1');
    expect(idFromPath('order%3Aabc-1')).toBe('order:abc-1');
  });
  it('keeps text that is not a valid escape', () => {
    expect(idFromPath('100%')).toBe('100%');
  });
});

describe('finding a transaction', () => {
  const items = [
    item({ id: 'l1' }),
    item({ id: 'f1', kind: 'trade', orderId: 'o1', asset: 'BTC', amount: '0.1' }),
    item({ id: 'f2', kind: 'trade', orderId: 'o1', direction: 'out', asset: 'USDT', amount: '6000' }),
  ];
  it('finds a single line by its id', () => {
    expect(findGroup(items, 'l1')?.main.id).toBe('l1');
  });
  it('finds a whole order by its row id or by any of its lines', () => {
    expect(findGroup(items, 'order:o1')?.lines).toHaveLength(2);
    expect(findGroup(items, 'f2')?.id).toBe('order:o1');
  });
  it('says nothing for an unknown or empty id', () => {
    expect(findGroup(items, 'zzz')).toBeNull();
    expect(findGroup(items, '')).toBeNull();
  });
});

describe('sharedOrder', () => {
  it('names the order every part belongs to, and nothing when the parts do not share one', () => {
    expect(sharedOrder([item({ orderId: 'o1', txId: 'a' }), item({ orderId: 'o1', txId: 'b' }), item({ orderId: 'o1', txId: 'c' })])).toBe(
      'o1',
    );
    expect(sharedOrder([item({ orderId: 'o1', txId: 'a' }), item({ orderId: 'o2', txId: 'b' })])).toBeNull();
    expect(sharedOrder([item({ txId: 'tx9' }), item({ id: 'l2', txId: 'tx9' })])).toBeNull();
    expect(sharedOrder([])).toBeNull();
  });
});
