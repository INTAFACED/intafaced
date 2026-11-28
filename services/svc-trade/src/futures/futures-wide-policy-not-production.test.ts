/**
 * Unit card — WIDE_POLICY is a test harness, not production D3
 * 1. Promise: partial-liq real-book tests do not claim production uses DEFAULT ladder
 * 2. Break: comment says Production still uses DEFAULT_FUTURES_LADDER_POLICY
 * 3. Done bar: that sentence is absent; live jobs omit ladderPolicy
 * 4. Class N
 * 5. Paths: svc-trade/src/futures/partial-liquidation-real-book.test.ts
 * 6. RED: Production still uses DEFAULT_FUTURES_LADDER_POLICY
 * 7. Collision: none
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, 'partial-liquidation-real-book.test.ts'), 'utf8');

describe('WIDE_POLICY is not claimed as production D3', () => {
  it('does not tell the next reader that production uses DEFAULT_FUTURES_LADDER_POLICY', () => {
    expect(src).not.toMatch(/Production still uses DEFAULT_FUTURES_LADDER_POLICY/);
    expect(src).toMatch(/Test harness only/);
  });
});
