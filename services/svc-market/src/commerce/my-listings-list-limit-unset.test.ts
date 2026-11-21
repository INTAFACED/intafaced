import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MarketError } from '../vendor-service.js';
import { userCopy } from '../user-copy.js';
import { assertMyListingsListLimit } from './commerce-service.js';

/**
 * myListings page size is refuse-closed when unset.
 *
 * myListings dumped every listing for the vendor with no LIMIT.
 * Blank must refuse. Owner/client may pass 50 explicitly.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

describe('myListings limit unset refuse', () => {
  it('assertMyListingsListLimit refuses blank / NaN / 0 — never invents 50', () => {
    expect(() => assertMyListingsListLimit(undefined)).toThrow(MarketError);
    expect(() => assertMyListingsListLimit(Number.NaN)).toThrow(MarketError);
    expect(() => assertMyListingsListLimit(0)).toThrow(MarketError);
    try {
      assertMyListingsListLimit(undefined);
      throw new Error('expected refuse');
    } catch (e) {
      expect(e).toBeInstanceOf(MarketError);
      expect((e as MarketError).code).toBe('market.my_listings_list_limit_unset');
      expect((e as MarketError).message).toBe(userCopy('market.my_listings_list_limit_unset'));
      expect((e as MarketError).message).not.toMatch(/50-listing|default 50/i);
    }
  });

  it('accepts owner-published 50 and caps at 50', () => {
    expect(assertMyListingsListLimit(50)).toBe(50);
    expect(assertMyListingsListLimit(1)).toBe(1);
    expect(assertMyListingsListLimit(20)).toBe(20);
    expect(assertMyListingsListLimit(51)).toBe(50);
  });

  it('myListings no longer dumps without LIMIT', () => {
    const src = readFileSync(join(ROOT, 'services/svc-market/src/commerce/commerce-service.ts'), 'utf8');
    const start = src.indexOf('async myListings(');
    const end = src.indexOf('async getListing(', start);
    const fn = src.slice(start, end === -1 ? undefined : end);
    expect(fn).toContain('assertMyListingsListLimit');
    expect(fn).toContain('LIMIT ${limit}');
    expect(fn).not.toMatch(/\?\? 50/);
  });

  it('router does not invent 50 when myListings omits limit', () => {
    const src = readFileSync(join(ROOT, 'services/svc-market/src/router.ts'), 'utf8');
    const start = src.indexOf('myListings: mountRecord(');
    const end = src.indexOf('marketData:', start);
    const fn = src.slice(start, end === -1 ? undefined : end);
    expect(fn).toContain('myListings(ctx.principal.userId, { limit: input?.limit })');
    expect(fn).not.toMatch(/input\?\.limit \?\? 50/);
    expect(fn).not.toMatch(/\?\? 50/);
  });
});
