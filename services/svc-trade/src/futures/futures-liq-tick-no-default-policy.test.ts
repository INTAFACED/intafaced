/**
 * Unit card — liquidation tick does not import placeholder D3 rungs
 * 1. Promise: live tick takes optional owner policy; omitted is skip, not DEFAULT
 * 2. Break: import DEFAULT_FUTURES_LADDER_POLICY from maintenance-ladder.js
 * 3. Done bar: the tick never loads the placeholder table and offers none; an omitted policy skips
 * 4. Class N
 * 5. Paths: svc-trade/src/futures/liquidation-tick.ts
 * 6. RED: import { DEFAULT_FUTURES_LADDER_POLICY } from './maintenance-ladder.js'
 * 7. Collision: none — liquidation-tick.test.ts drives the skip ("ladder without owner D3 policy skips")
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_FUTURES_LADDER_POLICY } from './ladder-policy.test-harness.js';

afterEach(() => {
  vi.doUnmock('./ladder-policy.test-harness.js');
  vi.resetModules();
});

/** Every value a module exports, and every value nested inside them, flattened. */
function exportedValues(mod: object): unknown[] {
  const out: unknown[] = [];
  const walk = (v: unknown, depth: number) => {
    out.push(v);
    if (depth > 4 || v === null || typeof v !== 'object') return;
    for (const inner of Object.values(v)) walk(inner, depth + 1);
  };
  for (const v of Object.values(mod)) walk(v, 0);
  return out;
}

describe('liquidation tick does not import placeholder D3 rungs', () => {
  it('maintenance-ladder import does not include DEFAULT_FUTURES_LADDER_POLICY', async () => {
    const loads: string[] = [];
    vi.resetModules();
    vi.doMock('./ladder-policy.test-harness.js', async (importOriginal) => {
      loads.push('harness');
      return importOriginal();
    });
    const tick = await import('./liquidation-tick.js');
    const ladder = await import('./maintenance-ladder.js');
    expect(typeof tick.runLiquidationTick).toBe('function');
    // Neither the tick nor the ladder module it rates with loads the placeholder table or offers one.
    expect(loads).toEqual([]);
    expect(ladder).not.toHaveProperty('DEFAULT_FUTURES_LADDER_POLICY');
  });

  it('does not pass DEFAULT as ladder policy', async () => {
    vi.resetModules();
    const tick = await import('./liquidation-tick.js');
    for (const value of exportedValues(tick)) {
      expect(value).not.toEqual(DEFAULT_FUTURES_LADDER_POLICY);
      expect(value).not.toEqual(DEFAULT_FUTURES_LADDER_POLICY.tiers);
    }
  });
});
