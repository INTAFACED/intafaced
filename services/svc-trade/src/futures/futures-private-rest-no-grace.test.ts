/**
 * Unit card — private REST margin-call door does not invent a grace clock
 * 1. Promise: GET /positions/:id/margin-call sends the presenter body as-is
 * 2. Break: route maps graceExpiresAt or retryAfter onto the 200
 * 3. Done bar: private-rest.ts has no graceExpiresAt; 200 is reply.send(call)
 * 4. Class N
 * 5. Paths: svc-trade/src/private-rest.ts
 * 6. RED: graceExpiresAt: on the GET margin-call handler
 * 7. Collision: none — #1924 pins transport; #1928 pins index.ts host
 */

import { describe, expect, it } from 'vitest';
import { DOOR_USER_ID, doorHeaders, privateRestDoor } from './testing/doors.js';
import { memoryMarginCallStore, presentMarginCallWire, type MarginCallWire } from './margin-call-transport.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

const POSITION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

async function getMarginCall(call: MarginCallWire | null) {
  const seen: string[] = [];
  const app = await privateRestDoor({
    getOpenMarginCall: async (principal, positionId) => {
      seen.push(`${principal.userId}:${positionId}`);
      return call;
    },
  });
  const res = await app.inject({ method: 'GET', url: `/api/v1/positions/${POSITION}/margin-call`, headers: doorHeaders() });
  await app.close();
  return { res, seen };
}

describe('private REST margin-call door does not invent grace', () => {
  it('does not mention graceExpiresAt', async () => {
    const row = await memoryMarginCallStore().recordDelivered({
      positionId: POSITION,
      userId: DOOR_USER_ID,
      marketId: 'BTC-PERP',
      healthBps: 11_000,
      at: new Date('2026-09-03T00:00:00.000Z'),
    });
    const { res, seen } = await getMarginCall(presentMarginCallWire(row));
    expect(res.statusCode).toBe(200);
    expect(seen).toEqual([`${DOOR_USER_ID}:${POSITION}`]);
    expect(res.json()).not.toHaveProperty('graceExpiresAt');
    expect(res.body).not.toMatch(/grace/i);
    // No call open: an honest 404, never an invented timer.
    const none = await getMarginCall(null);
    expect(none.res.statusCode).toBe(404);
    expect(none.res.json()).toMatchObject({ error: 'trade.margin_call_not_found' });
  });

  it('200 sends the host call body without wrapping extras', async () => {
    const call: MarginCallWire = {
      positionId: POSITION,
      userId: DOOR_USER_ID,
      marketId: 'BTC-PERP',
      sequence: 2,
      healthBps: 10_500,
      calledAt: '2026-09-03T00:00:00.000Z',
      deliveredAt: '2026-09-03T00:00:05.000Z',
      delivered: true,
    };
    const { res } = await getMarginCall(call);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(call);
  });
});

// Kept source pins: what these read is wired where no test can call it yet, or on paths a behaviour test does not drive.
// Each pin stays until a behaviour test holds the same property on every path.
describe('kept source pins', () => {
  const src = readFileSync(join(here, '..', 'private-rest.ts'), 'utf8');

  it('does not mention graceExpiresAt (kept source pin)', () => {
    expect(src).toMatch(/\/api\/v1\/positions\/:id\/margin-call/);
    expect(src).not.toMatch(/graceExpiresAt/);
  });

  it('200 sends the host call body without wrapping extras (kept source pin)', () => {
    expect(src).toMatch(/return reply\.code\(200\)\.send\(call\)/);
  });
});
