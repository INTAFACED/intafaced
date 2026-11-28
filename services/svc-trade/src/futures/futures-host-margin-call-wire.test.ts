/**
 * Unit card — live host GET margin-call is presenter-only, no grace extra
 * 1. Promise: getOpenMarginCall returns presentMarginCallWire(row) with no extra fields
 * 2. Break: host spreads graceExpiresAt or a timer onto the REST body
 * 3. Done bar: source matches return presentMarginCallWire(row); no graceExpiresAt
 * 4. Class N
 * 5. Paths: svc-trade/src/index.ts
 * 6. RED: return { ...presentMarginCallWire(row), graceExpiresAt: … }
 * 7. Collision: none — #1924 pins transport.ts; this pins the live host assembly
 */

import { describe, expect, it } from 'vitest';
import { memoryMarginCallStore, presentMarginCallWire } from './margin-call-transport.js';

describe('live host margin-call door does not invent grace', () => {
  it('getOpenMarginCall returns presentMarginCallWire(row) only', async () => {
    // The host's door reads the durable store the tick delivered into and presents the row: these fields, no more.
    const store = memoryMarginCallStore();
    const at = new Date('2026-09-03T00:00:00.000Z');
    await store.recordDelivered({ positionId: 'p1', userId: 'u1', marketId: 'BTC-PERP', healthBps: 11_000, at });
    const row = await store.getOpenForPosition('p1');
    expect(row).not.toBeNull();
    expect(presentMarginCallWire(row!)).toEqual({
      positionId: 'p1',
      userId: 'u1',
      marketId: 'BTC-PERP',
      sequence: 1,
      healthBps: 11_000,
      calledAt: at.toISOString(),
      deliveredAt: at.toISOString(),
      delivered: true,
    });
  });

  it('does not attach graceExpiresAt on the host path', async () => {
    const store = memoryMarginCallStore();
    const at = new Date('2026-09-03T00:00:00.000Z');
    await store.recordDelivered({ positionId: 'p1', userId: 'u1', marketId: 'BTC-PERP', healthBps: 11_000, at });
    // A re-tick refreshes the same open call; neither the row nor the wire ever carries a grace deadline.
    await store.recordDelivered({
      positionId: 'p1',
      userId: 'u1',
      marketId: 'BTC-PERP',
      healthBps: 10_900,
      at: new Date(at.getTime() + 15_000),
    });
    const row = await store.getOpenForPosition('p1');
    expect(row).not.toHaveProperty('graceExpiresAt');
    expect(JSON.stringify(presentMarginCallWire(row!))).not.toMatch(/grace/i);
  });
});
