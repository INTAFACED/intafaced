/**
 * CARD H7 — QuantLib adapter link-or-refuse (mill).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createGreeksAdapter,
  ieeeFloat64ToDecimalString,
  NATIVE_ENV,
  readQuantLibPin,
  type NativeIeeeGreeks,
  type NativeQuantLib,
} from '@intafaced/greeks-adapter';
import { quantLibNativeComposeWired } from './greeks-compose-wiring.js';
import { tradeRouterPaths } from '../__tests__/entry.js';
import { GREEK_KEYS, GREEKS_NATIVE_UNLINKED, whatIfVanillaGreeks } from './what-if.js';

const here = dirname(fileURLToPath(import.meta.url));

function completeVanilla() {
  return {
    right: 'call' as const,
    strike: '100',
    spot: '100',
    volatility: '0.2',
    timeToExpiry: '1',
    riskFreeRate: '0.01',
    dividendYield: '0',
  };
}

function assertNoInventedGreeks(result: object): void {
  for (const key of GREEK_KEYS) {
    expect(key in result, `refuse must not invent ${key}`).toBe(false);
  }
}

describe('H7 greeks mill — blank INTAFACED_QUANTLIB_NATIVE unlinks', () => {
  const previous = process.env[NATIVE_ENV];

  afterEach(() => {
    if (previous === undefined) delete process.env[NATIVE_ENV];
    else process.env[NATIVE_ENV] = previous;
  });

  it('blank env refuses numbers and does not invent Greeks', () => {
    delete process.env[NATIVE_ENV];
    const result = whatIfVanillaGreeks(completeVanilla());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.linked).toBe(false);
    expect(result.code).toBe(GREEKS_NATIVE_UNLINKED);
    expect(result.reason).toBe('native_unavailable');
    expect(result.message).toContain(NATIVE_ENV);
    assertNoInventedGreeks(result);
  });
});

describe('H7 greeks mill — linked QuantLib decimal strings, never IEEE', () => {
  it('stub QuantLib floats become decimal strings on the trade door', () => {
    const ieee: NativeIeeeGreeks = {
      npv: 0.1 + 0.2,
      delta: 0.5,
      gamma: 0.02,
      vega: 0.4,
      theta: -0.03,
    };
    const native: NativeQuantLib = {
      vanillaEuropean: () => ieee,
      yearFraction: () => 0.5,
    };
    const result = whatIfVanillaGreeks(completeVanilla(), { adapter: createGreeksAdapter({ native }) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const key of GREEK_KEYS) {
      expect(typeof result[key]).toBe('string');
    }
    expect(result.npv).toBe(ieeeFloat64ToDecimalString(0.1 + 0.2));
    expect(result.delta).toBe(ieeeFloat64ToDecimalString(0.5));
    const wire = JSON.parse(JSON.stringify(result)) as Record<string, unknown>;
    for (const key of GREEK_KEYS) {
      expect(typeof wire[key]).toBe('string');
    }
  });

  it('refuses an IEEE number on the input wire', () => {
    const native: NativeQuantLib = {
      vanillaEuropean: () => {
        throw new Error('native must not be called on IEEE input');
      },
      yearFraction: () => 0,
    };
    const result = whatIfVanillaGreeks(
      { ...completeVanilla(), strike: 100 as unknown as string },
      { adapter: createGreeksAdapter({ native }) },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('ieee_input');
    assertNoInventedGreeks(result);
  });
});

describe('H7 greeks mill — pin, no JS Black-Scholes, no listing, no settlement invent', () => {
  it('reuses QUANTLIB.pin.json SHA 6b57206e0459', () => {
    const pin = readQuantLibPin();
    expect(pin.commit).toBe('6b57206e04598f092efee66e3b367efc84771995');
    expect(pin.commit.startsWith('6b57206e0459')).toBe(true);
    expect(pin.version).toBe('1.43');
    expect(pin.never).toEqual(expect.arrayContaining(['IEEE NPV/Greeks on the wire', 'hand-rolled Black-Scholes labeled as QuantLib']));
  });

  it('trade greeks TypeScript does not implement d1/d2 or label JS Black-Scholes as QuantLib', () => {
    const files = readdirSync(here).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'));
    const joined = files.map((name) => readFileSync(join(here, name), 'utf8')).join('\n');
    expect(joined).toContain('@intafaced/greeks-adapter');
    expect(joined).not.toMatch(/\bd1\b/);
    expect(joined).not.toMatch(/\bd2\b/);
    expect(joined).not.toMatch(/erf\s*\(/);
    expect(joined).not.toMatch(/normalCdf|normCdf|cumulativeNormal/i);
    expect(joined).not.toMatch(/blackScholes/i);
    expect(joined).not.toMatch(/TRADE_OPTIONS_SETTLEMENT_ASSET_LAW/);
    expect(joined).not.toMatch(/options-listing/);
  });

  it('compose passes INTAFACED_QUANTLIB_NATIVE with empty default (unlink)', () => {
    expect(quantLibNativeComposeWired()).toBe(true);
  });

  it('router.ts / options-listing.ts not recut; index.ts mounts the door', async () => {
    // What-if greeks are their own REST door (index.boot.test.ts: 'mounts the greeks what-if, delta-hedge and promo
    // doors'): no tRPC procedure and nothing the options listing exports computes them.
    expect(tradeRouterPaths().filter((path) => /greek|what-?if/i.test(path))).toEqual([]);
    const listing = await import('../spot/options-listing.js');
    expect(Object.keys(listing).filter((name) => /greek|what-?if/i.test(name))).toEqual([]);
  });
});
