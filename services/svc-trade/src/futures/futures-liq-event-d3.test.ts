/**
 * Unit card — liquidation positionUpdated does not invent D3 or next funding
 * 1. Promise: tick-stores liquidated event uses stored liq_price / null mark, no ladder bps
 * 2. Break: event fills maintenanceBps from DEFAULT_FUTURES_LADDER_POLICY
 * 3. Done bar: source has no DEFAULT ladder, no maintenanceBps, no nextFundingTimestamp
 * 4. Class N
 * 5. Paths: svc-trade/src/futures/tick-stores.ts
 * 6. RED: maintenanceBps: or DEFAULT_FUTURES_LADDER_POLICY
 * 7. Collision: none — new file only
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

describe('liquidation positionUpdated does not invent D3', () => {
  it('does not import DEFAULT_FUTURES_LADDER_POLICY or emit maintenanceBps / nextFunding', async () => {
    const event = await liquidatedEvent();
    expect(event.type).toBe('positionUpdated');
    expect(event.payload).not.toHaveProperty('maintenanceBps');
    expect(event.payload).not.toHaveProperty('maintenanceMargin');
    expect(event.payload).not.toHaveProperty('nextFundingTimestamp');
  });

  it('liquidated mark stays null rather than an invented mid', async () => {
    const event = await liquidatedEvent();
    expect(event.payload.status).toBe('liquidated');
    expect(event.payload.markPrice).toBeNull();
  });
});
