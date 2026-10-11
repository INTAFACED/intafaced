/**
 * Unit card — DEX_INTERNAL_BOOK_FEE_BPS blank is not 0 bps.
 *
 * Whitespace-only is not an explicit fee. Number('   ') is 0, and 0 publishes
 * a quote. Blank / whitespace stay unset so the enabled internal book refuses.
 * Owner-explicit integers, including 0, still load.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InternalBookFeeUnconfiguredError, venuesFor, type VenueSetEnv } from './quote/venue-set.js';

const SECRET = 's'.repeat(32);

const BASE_ENV = {
  EDGE_PRINCIPAL_SECRET: SECRET,
};

async function loadWith(overrides: Record<string, string | undefined> = {}) {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('DEX_INTERNAL_BOOK_FEE_BPS', undefined);
  for (const [key, value] of Object.entries({ ...BASE_ENV, ...overrides })) {
    vi.stubEnv(key, value);
  }
  const module = await import('./env.js');
  return module.env;
}

function venueEnv(fee: number | undefined, enabled: boolean): VenueSetEnv {
  return {
    INDEXER_URL: 'http://indexer.test',
    MATCHING_URL: 'http://matching.test',
    QUOTE_MAX_AGE_MS: 2_000,
    DEX_QUOTE_DEPTH: 50,
    DEX_INTERNAL_BOOK_ENABLED: enabled,
    DEX_INTERNAL_BOOK_FEE_BPS: fee,
    DEX_EXTERNAL_VENUES: [],
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('DEX_INTERNAL_BOOK_FEE_BPS blank is not published as 0', () => {
  it('whitespace-only or blank stays unset so the quote refuses; explicit integers still load', async () => {
    const whitespace = await loadWith({ DEX_INTERNAL_BOOK_FEE_BPS: '   ' });
    expect(whitespace.DEX_INTERNAL_BOOK_FEE_BPS).toBeUndefined();
    expect(() => venuesFor(venueEnv(whitespace.DEX_INTERNAL_BOOK_FEE_BPS, whitespace.DEX_INTERNAL_BOOK_ENABLED), 'ROW')).toThrow(
      InternalBookFeeUnconfiguredError,
    );

    const blank = await loadWith({ DEX_INTERNAL_BOOK_FEE_BPS: '' });
    expect(blank.DEX_INTERNAL_BOOK_FEE_BPS).toBeUndefined();
    expect(() => venuesFor(venueEnv(blank.DEX_INTERNAL_BOOK_FEE_BPS, blank.DEX_INTERNAL_BOOK_ENABLED), 'ROW')).toThrow(
      InternalBookFeeUnconfiguredError,
    );

    const zero = await loadWith({ DEX_INTERNAL_BOOK_FEE_BPS: '0' });
    expect(zero.DEX_INTERNAL_BOOK_FEE_BPS).toBe(0);
    const quotedZero = venuesFor(venueEnv(zero.DEX_INTERNAL_BOOK_FEE_BPS, zero.DEX_INTERNAL_BOOK_ENABLED), 'ROW');
    expect(quotedZero.map((v) => v.id)).toEqual(['internal-book']);
    expect(quotedZero[0]?.feeBps).toBe(0);

    const explicit = await loadWith({ DEX_INTERNAL_BOOK_FEE_BPS: '20' });
    expect(explicit.DEX_INTERNAL_BOOK_FEE_BPS).toBe(20);

    const padded = await loadWith({ DEX_INTERNAL_BOOK_FEE_BPS: '  15  ' });
    expect(padded.DEX_INTERNAL_BOOK_FEE_BPS).toBe(15);
  });
});
