/**
 * Unit card — jobs assembly does not fall back to placeholder D3 rungs
 * 1. Promise: ladder.policy is deps.ladderPolicy only — omitted stays skip
 * 2. Break: policy: deps.ladderPolicy ?? DEFAULT_FUTURES_LADDER_POLICY
 * 3. Done bar: exact policy: deps.ladderPolicy; no ?? DEFAULT
 * 4. Class N
 * 5. Paths: svc-trade/src/futures/futures-jobs.ts
 * 6. RED: policy: deps.ladderPolicy ?? DEFAULT_FUTURES_LADDER_POLICY
 * 7. Collision: none — futures-jobs.test.ts pins import; this pins the coalescing
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, 'futures-jobs.ts'), 'utf8');

describe('futures jobs do not coalesce omitted D3 into DEFAULT rungs', () => {
  it('passes deps.ladderPolicy through with no fallback', () => {
    expect(src).toMatch(/policy:\s*deps\.ladderPolicy/);
    expect(src).not.toMatch(/policy:\s*deps\.ladderPolicy\s*\?\?/);
  });

  it('does not mention DEFAULT_FUTURES_LADDER_POLICY', () => {
    expect(src).not.toMatch(/DEFAULT_FUTURES_LADDER_POLICY/);
  });
});
