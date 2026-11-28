/**
 * Unit card — shipped config must not invent TRADE_FUTURES_FUNDING_MAX_ABS_RATE
 * 1. Promise: compose/env leave the ceiling empty; .env.example does not name a number
 * 2. Break: compose pins 0.01 or env defaults a decimal so publish looks lawful
 * 3. Done bar: env default(''); compose ${VAR:-}; example is commented with no value
 * 4. Class N
 * 5. Paths: env.ts · docker-compose.apps.yml · .env.example
 * 6. RED: TRADE_FUTURES_FUNDING_MAX_ABS_RATE: ${VAR:-0.01} or z.string().default('0.01')
 * 7. Collision: none — boot-config pins market ids + 8h interval; this pins the abs ceiling
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { tradeEnvWith } from './testing/doors.js';
import {
  FundingRateBoundError,
  assertFundingRateWithinBound,
  parseFundingMaxAbsRate,
  resolveFundingMaxAbsRateForBoot,
} from './funding-rate-bound.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const compose = readFileSync(join(root, 'docker-compose.apps.yml'), 'utf8');
const envExample = readFileSync(join(root, '.env.example'), 'utf8');

describe('shipped config does not invent a funding abs-rate ceiling', () => {
  it('env.ts defaults the ceiling to empty, not a decimal', () => {
    const raw = tradeEnvWith({}, ['TRADE_FUTURES_FUNDING_MAX_ABS_RATE']).TRADE_FUTURES_FUNDING_MAX_ABS_RATE;
    expect(raw).toBe('');
    // Unset is no bound: a rate is refused, and a funding market list without one stops boot.
    expect(parseFundingMaxAbsRate(raw)).toBeNull();
    expect(() => assertFundingRateWithinBound('0.0001', parseFundingMaxAbsRate(raw))).toThrow(FundingRateBoundError);
    expect(() => resolveFundingMaxAbsRateForBoot({ fundingMarketIds: ['m1'], maxAbsRateRaw: raw })).toThrow(/no product default/);
  });

  it('compose passes through empty rather than pinning a product number', () => {
    expect(compose).toMatch(/TRADE_FUTURES_FUNDING_MAX_ABS_RATE:\s*\$\{TRADE_FUTURES_FUNDING_MAX_ABS_RATE:-\}/);
    expect(compose).not.toMatch(/TRADE_FUTURES_FUNDING_MAX_ABS_RATE:\s*\$\{TRADE_FUTURES_FUNDING_MAX_ABS_RATE:-0/);
  });

  it('.env.example documents the key without assigning a ceiling', () => {
    expect(envExample).toMatch(/# TRADE_FUTURES_FUNDING_MAX_ABS_RATE=/);
    expect(envExample).not.toMatch(/^TRADE_FUTURES_FUNDING_MAX_ABS_RATE=/m);
  });
});

// Kept source pins: what these read is wired where no test can call it yet, or on paths a behaviour test does not drive.
// Each pin stays until a behaviour test holds the same property on every path.
describe('kept source pins', () => {
  const envSrc = readFileSync(join(root, 'services/svc-trade/src/env.ts'), 'utf8');

  it('env.ts defaults the ceiling to empty, not a decimal (kept source pin)', () => {
    expect(envSrc).toMatch(/TRADE_FUTURES_FUNDING_MAX_ABS_RATE:\s*z\.string\(\)\.default\(''\)/);
  });
});
