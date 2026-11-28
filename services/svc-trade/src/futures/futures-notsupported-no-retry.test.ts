/**
 * Unit card — NotSupported is 501 without retryAfter (live re-leverage / grace)
 * 1. Promise: notSupported is 501 NotSupported and does not carry retryAfter
 * 2. Break: add retryAfter so bots treat 501 as a throttle and hammer leverage
 * 3. Done bar: notSupported factory has status 501 and no retryAfter field
 * 4. Class N
 * 5. Paths: svc-trade/src/ccxt-errors.ts
 * 6. RED: retryAfter: inside notSupported
 * 7. Collision: none — ccxt-errors.test.ts asserts runtime; this pins the factory
 */

import { describe, expect, it } from 'vitest';
import { notSupported } from '../ccxt-errors.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

describe('notSupported does not look like a retryable throttle', () => {
  it('is 501 and has no retryAfter in the factory', () => {
    const wire = notSupported('setMarginMode is not available', 'trade.margin_mode_unsupported');
    expect(wire).toEqual({
      status: 501,
      body: { code: 'NotSupported', message: 'setMarginMode is not available', intafacedCode: 'trade.margin_mode_unsupported' },
    });
    expect(wire.body).not.toHaveProperty('retryAfter');
    expect(wire).not.toHaveProperty('retryAfter');
  });
});

// Kept source pins: what these read is wired where no test can call it yet, or on paths a behaviour test does not drive.
// Each pin stays until a behaviour test holds the same property on every path.
describe('kept source pins', () => {
  const src = readFileSync(join(here, '..', 'ccxt-errors.ts'), 'utf8');

  it('is 501 and has no retryAfter in the factory (kept source pin)', () => {
    const fn = src.match(/export function notSupported[\s\S]*?^}/m)?.[0] ?? '';
    expect(fn).toMatch(/status:\s*501/);
    expect(fn).toMatch(/code:\s*'NotSupported'/);
    expect(fn).not.toMatch(/retryAfter/);
  });
});
