import { describe, expect, it } from 'vitest';
import { activityPageSchema } from '../../data/activity';
import { groupActivity } from './activity-view';

/** PF-activity-02 screen half: a purchase line is known, so its detail can link to the asset's history. */

const wire = (over: Record<string, unknown>) => ({
  id: 'a',
  kind: 'trade',
  direction: 'in',
  asset: 'BTC',
  amount: '0.01',
  postedAt: '2026-10-10T12:00:00Z',
  txId: 'tx-1',
  orderId: 'order-1',
  ...over,
});

describe('purchase lines', () => {
  it('reads the purchase flag and leaves it absent on any other line', () => {
    const page = activityPageSchema.parse({
      items: [wire({ purchase: true }), wire({ id: 'b', direction: 'out', asset: 'USDT' })],
      nextCursor: null,
    });
    expect(page.items[0]?.purchase).toBe(true);
    expect(page.items[1]?.purchase).toBeUndefined();
  });
  it('keeps the flag on the lines of the group the detail page reads', () => {
    const page = activityPageSchema.parse({
      items: [wire({ purchase: true }), wire({ id: 'b', direction: 'out', asset: 'USDT', amount: '600' })],
      nextCursor: null,
    });
    const group = groupActivity(page.items).groups[0]!;
    expect(group.lines.find((line) => line.purchase === true)?.asset).toBe('BTC');
  });
});
