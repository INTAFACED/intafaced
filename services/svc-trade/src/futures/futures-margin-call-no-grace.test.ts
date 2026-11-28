/**
 * Unit card — margin-call public wire does not invent a D3 grace clock
 * 1. Promise: GET margin-call is delivery identity only; grace duration stays unset
 * 2. Break: wire / presenter / SQL upsert a graceExpiresAt or grace_expires_at
 * 3. Done bar: no graceExpiresAt: field, no grace_expires_at column in this file
 * 4. Class N
 * 5. Paths: svc-trade/src/futures/margin-call-transport.ts
 * 6. RED: graceExpiresAt: on MarginCallWire or INSERT grace_expires_at
 * 7. Collision: none — maintenance-ladder.ts owns the pure grace seals; this pins transport
 */

import { describe, expect, it } from 'vitest';
import { memoryMarginCallStore, presentMarginCallWire, sqlMarginCallStore } from './margin-call-transport.js';

const CALL = {
  positionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  userId: '11111111-1111-4111-8111-111111111111',
  marketId: 'BTC-PERP',
  healthBps: 11_000,
  at: new Date('2026-09-03T00:00:00.000Z'),
};
const WIRE_KEYS = ['calledAt', 'delivered', 'deliveredAt', 'healthBps', 'marketId', 'positionId', 'sequence', 'userId'];

describe('margin-call transport does not invent a grace clock', () => {
  it('does not put graceExpiresAt on the public wire or durable row', async () => {
    const row = await memoryMarginCallStore().recordDelivered(CALL);
    expect(row).not.toHaveProperty('graceExpiresAt');
    const wire = presentMarginCallWire(row);
    expect(Object.keys(wire).sort()).toEqual(WIRE_KEYS);
    expect(wire).toEqual({
      positionId: CALL.positionId,
      userId: CALL.userId,
      marketId: CALL.marketId,
      sequence: 1,
      healthBps: CALL.healthBps,
      calledAt: CALL.at.toISOString(),
      deliveredAt: CALL.at.toISOString(),
      delivered: true,
    });
  });

  it('SQL store does not persist a grace column', async () => {
    // The store writes only the call's own columns, and a grace column in the reply would not reach the record.
    const queries: string[] = [];
    const sql = Object.assign(
      (strings: TemplateStringsArray) => {
        queries.push(strings.join('?'));
        return Promise.resolve([
          {
            position_id: CALL.positionId,
            user_id: CALL.userId,
            market_id: CALL.marketId,
            sequence: 1,
            health_bps: CALL.healthBps,
            called_at: CALL.at,
            delivered_at: CALL.at,
            cleared_at: null,
            grace_expires_at: new Date('2026-09-03T01:00:00.000Z'),
          },
        ]);
      },
      { begin: async (fn: (tx: unknown) => unknown) => fn(sql) },
    );
    const row = await sqlMarginCallStore(sql as never).recordDelivered(CALL);
    expect(queries.some((q) => /INSERT INTO trade\.position_margin_calls/.test(q))).toBe(true);
    expect(queries.join('\n')).not.toMatch(/grace/i);
    expect(row).not.toHaveProperty('graceExpiresAt');
    expect(Object.keys(presentMarginCallWire(row)).sort()).toEqual(WIRE_KEYS);
  });
});
