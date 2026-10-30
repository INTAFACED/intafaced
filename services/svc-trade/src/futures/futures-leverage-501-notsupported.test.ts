/**
 * Unit card — live re-leverage is isolated+capped; margin-mode stays NotSupported
 * 1. Promise: POST /positions/leverage is a real door; /margin-mode uses notSupported
 * 2. Break: margin-mode calls rateLimited so bots retry with backoff
 * 3. Done bar: leverage handler is not derivativesNotSupported; margin-mode still is
 * 4. Class N
 * 5. Paths: svc-trade/src/private-rest.ts · futures/position-service.ts · index.ts
 * 6. RED: rateLimited( inside derivativesNotSupported, or leverage still 501-mounted,
 *    or setLeverage deleted / no longer posts futuresMarginAdd/Release
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FUTURES_HONEST_GAPS, futuresLiveReleverageMounted } from './mount-vs-tracker.js';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'private-rest.ts'), 'utf8');
const service = readFileSync(join(here, 'position-service.ts'), 'utf8');
const indexSrc = readFileSync(join(here, '..', 'index.ts'), 'utf8');
const setLev = service.match(/async setLeverage\([\s\S]*?^  async addIsolatedMargin/m)?.[0] ?? '';

describe('live re-leverage is mounted; margin-mode stays NotSupported', () => {
  it('POST leverage is a real handler, not the 501 helper', () => {
    expect(src).toMatch(/app\.post\('\/api\/v1\/positions\/leverage',\s*privateWrite,\s*async/);
    expect(src).not.toMatch(/app\.post\('\/api\/v1\/positions\/leverage',\s*(?:privateWrite,\s*)?derivativesNotSupported\('setLeverage'/);
    expect(src).toMatch(/deps\.setLeverage\(/);
    expect(src).toMatch(/typeof body\.leverage === 'string'/);
  });

  it('deleting setLeverage live path fails — service posts ledger add/release', () => {
    expect(setLev).toMatch(/async setLeverage\(/);
    expect(setLev).toMatch(/recipes\.futuresMarginAdd\(/);
    expect(setLev).toMatch(/recipes\.futuresMarginRelease\(/);
    expect(setLev).not.toMatch(/notSupported\(/);
    expect(indexSrc).toMatch(/positions\.setLeverage\(/);
    expect(futuresLiveReleverageMounted()).toBe(true);
    expect(FUTURES_HONEST_GAPS).not.toContain('gap.live_releverage_501');
  });

  it('POST margin-mode still uses the derivativesNotSupported helper', () => {
    expect(src).toMatch(/app\.post\('\/api\/v1\/positions\/margin-mode',\s*privateWrite,\s*derivativesNotSupported\('setMarginMode'/);
  });

  it('the helper sends notSupported, not rateLimited', () => {
    const helper = src.match(/const derivativesNotSupported[\s\S]*?^\s*\};/m)?.[0] ?? '';
    expect(helper).toMatch(/notSupported\(/);
    expect(helper).not.toMatch(/rateLimited\(/);
  });
});
