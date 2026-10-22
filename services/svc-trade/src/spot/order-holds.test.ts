import { parseAmount as amt } from '@intafaced/ledger-client';
import type { Sql } from 'postgres';
import { describe, expect, it } from 'vitest';
import { readOrderHolds } from './order-holds.js';
import type { OrderRecord } from './types.js';

/** A tagged-template stand-in that answers the one fills query with the given rows and records the ids it was asked for. */
function fillsSql(rows: Array<{ order_id: string; base: string; quote: string }>) {
  const asked: string[][] = [];
  const sql = ((first: unknown, ...values: unknown[]) => {
    if (!Array.isArray(first) || !('raw' in first)) return { ids: first };
    asked.push((values[0] as { ids: string[] }).ids);
    return Promise.resolve(rows);
  }) as unknown as Sql;
  return { sql, asked };
}

const order = (id: string, over: Partial<OrderRecord> = {}): OrderRecord =>
  ({
    id,
    side: 'buy',
    status: 'open',
    holdAsset: 'USDT',
    holdAmount: amt('100'),
    amendReleased: 0n,
    ...over,
  }) as OrderRecord;

describe('readOrderHolds', () => {
  it('a buy holds quote less the quote its fills spent and what an amend released; a sell holds base less its filled qty', async () => {
    const { sql } = fillsSql([
      { order_id: 'b', base: '0.5', quote: '30' },
      { order_id: 's', base: '0.25', quote: '999' },
    ]);
    const holds = await readOrderHolds(sql, [
      order('b', { amendReleased: amt('20') }),
      order('s', { side: 'sell', holdAsset: 'BTC', holdAmount: amt('1') }),
      order('n'),
    ]);
    expect(holds.get('b')).toEqual({ asset: 'USDT', amount: '50' });
    expect(holds.get('s')).toEqual({ asset: 'BTC', amount: '0.75' });
    expect(holds.get('n')).toEqual({ asset: 'USDT', amount: '100' });
  });

  it('states nothing for closed or unresolved orders, and asks the database only about live ones', async () => {
    const { sql, asked } = fillsSql([]);
    const holds = await readOrderHolds(sql, [
      order('p', { status: 'pending' }),
      ...(['filled', 'cancelled', 'rejected', 'expired', 'recovery_required', 'hold_unknown'] as const).map((status) =>
        order(status, { status }),
      ),
    ]);
    expect([...holds.keys()]).toEqual(['p']);
    expect(asked).toEqual([['p']]);
  });

  it('never queries for an empty list', async () => {
    const { sql, asked } = fillsSql([]);
    expect((await readOrderHolds(sql, [order('x', { status: 'filled' })])).size).toBe(0);
    expect(asked).toEqual([]);
  });

  it('an order whose fills spent more than its hold is left out, never shown as a negative or a zero', async () => {
    const { sql } = fillsSql([{ order_id: 'o', base: '1', quote: '101' }]);
    expect((await readOrderHolds(sql, [order('o')])).has('o')).toBe(false);
  });
});
