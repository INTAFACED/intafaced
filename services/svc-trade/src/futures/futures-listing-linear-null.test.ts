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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

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

// Kept source pins: what these read is wired where no test can call it yet, or on paths a behaviour test does not drive.
// Each pin stays until a behaviour test holds the same property on every path.
describe('kept source pins', () => {
  const src = readFileSync(join(here, '..', 'public-rest.ts'), 'utf8');

  const presenter = src.match(/export function presentCcxtMarket[\s\S]*?^}/m)?.[0] ?? '';

  it('extracts presentCcxtMarket (kept source pin)', () => {
    expect(presenter).toMatch(/export function presentCcxtMarket/);
  });

  it('derives linear and inverse from the stored family, never from the kind (kept source pin)', () => {
    expect(presenter).toMatch(/linear:\s*family === null \? \(null as boolean \| null\) : family === 'linear'/);
    expect(presenter).toMatch(/inverse:\s*family === null \? \(null as boolean \| null\) : family === 'inverse'/);
    expect(presenter).toMatch(/settle:\s*settleAsset/);
    expect(presenter).not.toMatch(/linear:\s*isSpot \? null : true/);
    expect(presenter).not.toMatch(/inverse:\s*isSpot \? null : false/);
  });
});
