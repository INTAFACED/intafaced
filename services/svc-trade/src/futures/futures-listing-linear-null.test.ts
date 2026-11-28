/**
 * Unit card — fetchMarkets must not invent linear/inverse without a stored family
 * 1. Promise: presentCcxtMarket reads linear/inverse/settle only from the stored listing family and settle asset
 *    (D-instruments-03: the listing record now carries both); a row that recorded none stays null
 * 2. Break: linear: isSpot ? null : true (invented USDT-margined book)
 * 3. Done bar: linear/inverse/settle are null on the presenter for a listing without a stored family
 * 4. Class N
 * 5. Paths: svc-trade/src/public-rest.ts
 * 6. RED: linear: isSpot ? null : true
 * 7. Collision: none — #1939 pins contractSize/leverage; this pins contract type
 */

import { describe, expect, it } from 'vitest';
import { fakeMarket, presentCcxtMarket } from '../public-rest.js';

describe('listed markets do not invent linear/inverse without settle', () => {
  it('derives linear and inverse from the stored family, never from the kind', () => {
    const perp = fakeMarket({ symbol: 'BTC/USDT-PERP', kind: 'futures' });
    expect(presentCcxtMarket({ ...perp, futuresFamily: 'inverse' as const })).toMatchObject({
      linear: false,
      inverse: true,
      family: 'inverse',
    });
    // Spot and options carry no family, so neither flag is claimed.
    for (const kind of ['spot', 'options'] as const) {
      const wire = presentCcxtMarket(fakeMarket({ symbol: `BTC/USDT-${kind}`, kind }));
      expect(wire.linear, kind).toBeNull();
      expect(wire.inverse, kind).toBeNull();
      expect(wire.settle, kind).toBeNull();
    }
  });

  it('keeps linear, inverse and settle null on a futures listing that recorded no family', () => {
    const wire = presentCcxtMarket(fakeMarket({ symbol: 'BTC/USDT-PERP', kind: 'futures' }));
    expect(wire.linear).toBeNull();
    expect(wire.inverse).toBeNull();
    expect(wire.settle).toBeNull();
    expect(wire.family).toBeNull();
    expect(wire.settleAsset).toBeNull();
  });

  it('publishes the stored family and settle asset, and nothing else', () => {
    const stored = {
      ...fakeMarket({ symbol: 'BTC/USDT-PERP', kind: 'futures' }),
      futuresFamily: 'linear' as const,
      futuresSettleAsset: 'USDT',
    };
    const wire = presentCcxtMarket(stored);
    expect(wire).toMatchObject({ linear: true, inverse: false, settle: 'USDT', family: 'linear', settleAsset: 'USDT' });
  });
});
