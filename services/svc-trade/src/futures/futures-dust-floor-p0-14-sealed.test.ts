/**
 * Unit card — D26-P0-14 dust floor stays shipped 100 / 100 bps, not "awaiting"
 * 1. Promise: production keeps DEFAULT_MIN_BEST_LEVEL_* and cites the ADR
 * 2. Break: change '100' or restore PLACEHOLDER FOR AN OWNER RULING
 * 3. Done bar: constants unchanged; comments name adr/2026-08-13-mark-dust-floor
 * 4. Class N
 * 5. Paths: mark-from-depth.ts · mark-from-venue.ts · mm/mid-source.ts
 * 6. RED: PLACEHOLDER FOR AN OWNER RULING or DEFAULT_MIN_BEST_LEVEL_NOTIONAL = '500'
 * 7. Collision: none — does not retune the pair (ADR forbids)
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const depth = readFileSync(join(here, 'mark-from-depth.ts'), 'utf8');
const venue = readFileSync(join(here, 'mark-from-venue.ts'), 'utf8');
const mm = readFileSync(join(here, '..', 'mm', 'mid-source.ts'), 'utf8');

describe('D26-P0-14 dust floor is sealed, not awaiting', () => {
  it('keeps the shipped pair', () => {
    expect(depth).toMatch(/export const DEFAULT_MIN_BEST_LEVEL_NOTIONAL = '100'/);
    expect(depth).toMatch(/export const DEFAULT_MIN_BEST_LEVEL_BPS_OF_NOTIONAL = 100/);
  });

  it('cites the seal ADR and does not call the pair an open placeholder', () => {
    expect(depth).toMatch(/2026-08-13-mark-dust-floor/);
    expect(depth).toMatch(/D26-P0-14/);
    expect(depth).not.toMatch(/PLACEHOLDER FOR AN OWNER RULING/);
    expect(depth).not.toMatch(/placeholder for an owner ruling/);
  });

  it('venue and MM paths do not claim the floor is still awaiting a ruling', () => {
    expect(venue).not.toMatch(/awaiting/);
    expect(mm).not.toMatch(/awaiting an owner ruling/);
    expect(mm).toMatch(/D26-P0-14/);
  });
});
