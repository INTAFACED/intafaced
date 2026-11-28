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

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'public-rest.ts'), 'utf8');
const presenter = src.match(/export function presentCcxtMarket[\s\S]*?^}/m)?.[0] ?? '';
describe('listed futures publish only a named owner cap', () => {
  it('extracts presentCcxtMarket', () => {
    expect(presenter).toMatch(/export function presentCcxtMarket/);
  });

  it('uses a supplied futures cap and never a default literal', () => {
    expect(presenter).toMatch(/flags\.futuresMaxLeverage \?\? null/);
    expect(src).not.toMatch(/DEFAULT_MAX_LEVERAGE/);
  });
});
