/**
 * Unit card — liquidation tick never starts a D3 grace clock
 * 1. Promise: seize-from-grace is called with graceExpiresAt: null only
 * 2. Break: tick invents graceExpiresAt from now+duration or a named ms default
 * 3. Done bar: source has graceExpiresAt: null at the C15 call; no graceDurationMs
 * 4. Class N
 * 5. Paths: svc-trade/src/futures/liquidation-tick.ts
 * 6. RED: graceExpiresAt: new Date(at.getTime() + …)
 * 7. Collision: none — #1925 pins DEFAULT import; this pins the grace argument
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, 'liquidation-tick.ts'), 'utf8');

describe('liquidation tick does not invent a grace clock', () => {
  it('passes graceExpiresAt: null into the C15 seize seal', () => {
    expect(src).toMatch(/mayLiquidateFromExpiredMarginCallGrace/);
    expect(src).toMatch(/graceExpiresAt:\s*null/);
  });

  it('does not name a grace duration', () => {
    expect(src).not.toMatch(/graceDurationMs|GRACE_MS|graceMs\s*:/);
    expect(src).not.toMatch(/graceExpiresAt:\s*new Date/);
  });
});
