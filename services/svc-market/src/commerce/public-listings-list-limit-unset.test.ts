import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MarketError } from '../vendor-service.js';
import { userCopy } from '../user-copy.js';
import { assertPublicListingsListLimit } from './commerce-service.js';

/**
 * publicListings page size is refuse-closed when unset.
 *
 * publicListings used `opts?.limit ?? 50`, so omit invented a 50-listing page.
 * Blank must refuse. Owner/client may pass 50 explicitly.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

describe('publicListings limit unset refuse', () => {
  it('assertPublicListingsListLimit refuses blank / NaN / 0 — never invents 50', () => {
    expect(() => assertPublicListingsListLimit(undefined)).toThrow(MarketError);
    expect(() => assertPublicListingsListLimit(Number.NaN)).toThrow(MarketError);
    expect(() => assertPublicListingsListLimit(0)).toThrow(MarketError);
    try {
      assertPublicListingsListLimit(undefined);
      throw new Error('expected refuse');
    } catch (e) {
      expect(e).toBeInstanceOf(MarketError);
      expect((e as MarketError).code).toBe('market.public_listings_list_limit_unset');
      expect((e as MarketError).message).toBe(userCopy('market.public_listings_list_limit_unset'));
      expect((e as MarketError).message).not.toMatch(/50-listing|default 50/i);
    }
  });

  it('accepts owner-published 50 and caps at 50', () => {
    expect(assertPublicListingsListLimit(50)).toBe(50);
    expect(assertPublicListingsListLimit(1)).toBe(1);
    expect(assertPublicListingsListLimit(20)).toBe(20);
    expect(assertPublicListingsListLimit(51)).toBe(50);
  });

  it('publicListings no longer defaults limit to 50', () => {
    const src = readFileSync(join(ROOT, 'services/svc-market/src/commerce/commerce-service.ts'), 'utf8');
    const start = src.indexOf('async publicListings(');
    const end = src.indexOf('async subscribe(', start);
    const fn = src.slice(start, end === -1 ? undefined : end);
    expect(fn).toContain('assertPublicListingsListLimit');
    expect(fn).not.toMatch(/\?\? 50/);
  });

  it('router does not invent 50 when listings omits limit', () => {
    const src = readFileSync(join(ROOT, 'services/svc-market/src/router.ts'), 'utf8');
    const start = src.indexOf('listings: publicProcedure');
    const end = src.indexOf('subscribe:', start);
    const fn = src.slice(start, end === -1 ? undefined : end);
    expect(fn).toContain('publicListings({ limit: input?.limit })');
    expect(fn).not.toMatch(/input\?\.limit \?\? 50/);
    expect(fn).not.toMatch(/\?\? 50/);
  });
});
