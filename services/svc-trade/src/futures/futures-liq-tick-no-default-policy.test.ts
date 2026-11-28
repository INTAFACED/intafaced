/**
 * Unit card — liquidation tick does not import placeholder D3 rungs
 * 1. Promise: live tick takes optional owner policy; omitted is skip, not DEFAULT
 * 2. Break: import DEFAULT_FUTURES_LADDER_POLICY from maintenance-ladder.js
 * 3. Done bar: maintenance-ladder import has no DEFAULT constant; no policy: DEFAULT
 * 4. Class N
 * 5. Paths: svc-trade/src/futures/liquidation-tick.ts
 * 6. RED: import { DEFAULT_FUTURES_LADDER_POLICY } from './maintenance-ladder.js'
 * 7. Collision: none — liquidation-tick.test.ts only pins ?? DEFAULT; this pins the import
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, 'liquidation-tick.ts'), 'utf8');

describe('liquidation tick does not import placeholder D3 rungs', () => {
  it('maintenance-ladder import does not include DEFAULT_FUTURES_LADDER_POLICY', () => {
    const importBlock = src.match(/import \{[\s\S]*?\} from '\.\/maintenance-ladder\.js';/)?.[0] ?? '';
    expect(importBlock).toMatch(/from '\.\/maintenance-ladder\.js'/);
    expect(importBlock).not.toMatch(/DEFAULT_FUTURES_LADDER_POLICY/);
  });

  it('does not pass DEFAULT as ladder policy', () => {
    expect(src).not.toMatch(/policy:\s*DEFAULT_FUTURES_LADDER_POLICY/);
    expect(src).not.toMatch(/ladder:\s*DEFAULT_FUTURES_LADDER_POLICY/);
  });
});
