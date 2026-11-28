/**
 * Unit card — liquidated positionUpdated does not invent unrealized PnL
 * 1. Promise: tick-stores liquidated event hard-nulls unrealizedPnl and markPrice
 * 2. Break: fill unrealized from entry vs an invented mark
 * 3. Done bar: unrealizedPnl: null and markPrice: null on that publish
 * 4. Class N
 * 5. Paths: svc-trade/src/futures/tick-stores.ts
 * 6. RED: unrealizedPnl: formatAmount(…)
 * 7. Collision: none — #1921 pins D3 bps / nextFunding; this pins PnL fields
 */

import { describe, expect, it } from 'vitest';
import { sqlPositionCloser } from './tick-stores.js';

/** Announce one liquidated position through the closer, over a row the sql answers, and return what reached the bus. */
async function liquidatedEvent() {
  const published: Array<{ type: string; payload: Record<string, unknown>; opts: unknown }> = [];
  const sql = (() =>
    Promise.resolve([
      {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        user_id: '11111111-1111-4111-8111-111111111111',
        market_id: 'm-perp',
        side: 'long',
        size: '2',
        entry_price: '50000',
        leverage: '5',
        margin_initial: '20000',
        margin_current: '150',
        margin_mode: 'isolated',
        funding_paid: '0',
        liq_price: '40000',
        symbol: 'BTC/USDT-PERP',
      },
    ])) as never;
  const bus = {
    publish: async (type: string, payload: Record<string, unknown>, opts: unknown) => {
      published.push({ type, payload, opts });
    },
  };
  await sqlPositionCloser(sql, bus as never).announceLiquidated!('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', {
    liquidationId: 'liq-1',
    reason: 'test',
  });
  expect(published).toHaveLength(1);
  return published[0]!;
}

describe('liquidated positionUpdated does not invent unrealized PnL', () => {
  it('hard-nulls unrealizedPnl and markPrice on the liquidated publish', async () => {
    const event = await liquidatedEvent();
    expect(event.payload).toMatchObject({ status: 'liquidated', unrealizedPnl: null, markPrice: null, realizedPnl: null });
    expect(event.opts).toEqual({ idempotencyKey: 'trade.position.liquidated:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:liq-1' });
  });

  it('does not format unrealized from a mark', async () => {
    // The row's entry, size and liquidation price are on the event; nothing is valued off a mark.
    const event = await liquidatedEvent();
    expect(event.payload).toMatchObject({ entryPrice: '50000', contracts: '2', liquidationPrice: '40000', collateral: '150' });
    expect(event.payload.unrealizedPnl).toBeNull();
  });
});
