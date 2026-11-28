/**
 * Unit card — funding publish refuses an unnamed period (no 8h clock bucket)
 * 1. Promise: periodId or periodStartIso is required; never derived from asOfMs
 * 2. Break: mint periodId from Date.now() or 8h millis
 * 3. Done bar: unnamed period is 400; source has no 28800000
 * 4. Class N
 * 5. Paths: svc-trade/src/futures/internal-funding-rate.ts
 * 6. RED: periodId = new Date(asOfMs).toISOString()
 * 7. Collision: none — behavioral suite already covers 400; this pins the source
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, 'internal-funding-rate.ts'), 'utf8');

describe('funding publish does not invent a period from the clock', () => {
  it('refuses when periodId and periodStartIso are both missing', () => {
    expect(src).toMatch(/if \(!rawPeriodId && !rawStartIso\)/);
    expect(src).toMatch(/periodId or periodStartIso is required/);
  });

  it('does not pin an 8h period identity', () => {
    expect(src).not.toMatch(/28_?800_?000|28800000/);
  });
});
