/**
 * Unit card — CCXT matrix does not advertise a margin-call grace clock
 * 1. Promise: fetchPositionMarginCall notes say never invents; no graceExpiresAt
 * 2. Break: matrix claims a grace timer or setMarginMode as supported
 * 3. Done bar: no graceExpiresAt; setMarginMode stays refuse; setLeverage is supported
 * 4. Class N
 * 5. Paths: svc-trade/src/ccxt-capability-matrix.ts
 * 6. RED: graceExpiresAt in notes, or setMarginMode kind supported
 * 7. Collision: none — REST/host pins are other files; this pins the bot matrix
 */

import { describe, expect, it } from 'vitest';
import { CCXT_CAPABILITY_MATRIX, refuseArmById } from '../ccxt-capability-matrix.js';

const row = (name: string) => CCXT_CAPABILITY_MATRIX.find((r) => r.name === name);

describe('CCXT matrix does not invent futures grace; margin-mode stays refuse', () => {
  it('fetchPositionMarginCall does not mention graceExpiresAt', () => {
    const call = row('fetchPositionMarginCall');
    expect(call).toMatchObject({ method: 'GET', path: '/api/v1/positions/:id/margin-call', kind: 'supported' });
    expect(call!.notes).toMatch(/never invents/);
    for (const r of CCXT_CAPABILITY_MATRIX) expect(JSON.stringify(r), r.name).not.toMatch(/grace/i);
  });

  it('setLeverage is supported within 10×; setMarginMode stays refuse', () => {
    expect(row('setLeverage')).toMatchObject({ kind: 'supported' });
    expect(row('setLeverage')!.notes).toMatch(/10×/);
    expect(row('setMarginMode')).toMatchObject({ kind: 'refuse', refuseArmIds: ['setMarginMode'] });
    expect(refuseArmById('setMarginMode')).toBeDefined();
  });
});
