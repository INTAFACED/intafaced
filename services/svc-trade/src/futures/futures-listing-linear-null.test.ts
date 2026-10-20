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

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { fakeMarket, presentCcxtMarket } from '../public-rest.js';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'public-rest.ts'), 'utf8');
const presenter = src.match(/export function presentCcxtMarket[\s\S]*?^}/m)?.[0] ?? '';

describe('listed markets do not invent linear/inverse without settle', () => {
  it('extracts presentCcxtMarket', () => {
    expect(presenter).toMatch(/export function presentCcxtMarket/);
  });

  it('derives linear and inverse from the stored family, never from the kind', () => {
    expect(presenter).toMatch(/linear:\s*family === null \? \(null as boolean \| null\) : family === 'linear'/);
    expect(presenter).toMatch(/inverse:\s*family === null \? \(null as boolean \| null\) : family === 'inverse'/);
    expect(presenter).toMatch(/settle:\s*settleAsset/);
    expect(presenter).not.toMatch(/linear:\s*isSpot \? null : true/);
    expect(presenter).not.toMatch(/inverse:\s*isSpot \? null : false/);
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
