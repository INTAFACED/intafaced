/**
 * Unit card — fetchMarkets publishes DIRECTION §1 10× on futures only
 * 1. Promise: presentCcxtMarket publishes only an explicit futures owner cap
 * 2. Break: fill blank with 10, or copy the futures cap onto spot/options
 * 3. Done bar: unset futures/spot/options stay null; named futures cap survives
 * 4. Class N
 * 5. Paths: svc-trade/src/public-rest.ts
 * 6. RED: leverage: { min: null, max: null } with no futures branch
 * 7. Collision: none — #1939 nulled leverage while 10× was treated as unpublished; P0-07 restored the cap
 */

import { describe, expect, it } from 'vitest';
import * as publicRest from '../public-rest.js';
import { fakeMarket, presentCcxtMarket } from '../public-rest.js';

const KINDS = ['spot', 'futures', 'options'] as const;
const CAPS = [undefined, null, '5', '7.5', '10'] as const;

describe('listed futures publish only a named owner cap', () => {
  it('extracts presentCcxtMarket', () => {
    expect(typeof presentCcxtMarket).toBe('function');
    expect(presentCcxtMarket(fakeMarket({ kind: 'futures', symbol: 'BTC/USDT-PERP' })).limits.leverage).toEqual({ min: null, max: null });
  });

  it('uses a supplied futures cap and never a default literal', () => {
    // Every kind, every cap the host can hand it (none, null, a named one), orderable or not: the futures max is the
    // cap exactly as handed, every other kind is null, and the min is never filled.
    for (const kind of KINDS) {
      for (const futuresMaxLeverage of CAPS) {
        for (const futuresOrderable of [undefined, false, true]) {
          const wire = presentCcxtMarket(fakeMarket({ kind, symbol: `BTC/USDT-${kind}` }), 0, {
            ...(futuresMaxLeverage !== undefined ? { futuresMaxLeverage } : {}),
            ...(futuresOrderable !== undefined ? { futuresOrderable } : {}),
          });
          const label = `${kind} ${String(futuresMaxLeverage)} ${String(futuresOrderable)}`;
          expect(wire.limits.leverage, label).toEqual({
            min: null,
            max: kind === 'futures' ? (futuresMaxLeverage ?? null) : null,
          });
        }
      }
    }
    // The module offers no default cap of its own to fall back on.
    expect(publicRest).not.toHaveProperty('DEFAULT_MAX_LEVERAGE');
    expect(Object.values(publicRest as Record<string, unknown>).filter((v) => v === 10 || v === '10' || v === '10×')).toEqual([]);
  });
});
