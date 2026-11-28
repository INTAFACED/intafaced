import { describe, expect, it } from 'vitest';
import { partial } from '@intafaced/service-kit/testing';
import { MemoryLedger } from '@intafaced/ledger-client';
import { recordingSql } from '../sql-recorder.testkit.js';
import { MarketError, type VendorRecord, type VendorService } from '../vendor-service.js';
import { userCopy } from '../user-copy.js';
import { CommerceService, assertMyListingsListLimit } from './commerce-service.js';

/**
 * myListings page size is refuse-closed when unset.
 *
 * myListings dumped every listing for the vendor with no LIMIT.
 * Blank must refuse. Owner/client may pass 50 explicitly.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const VENDOR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const APPROVED_VENDOR: VendorRecord = {
  id: VENDOR,
  userId: '22222222-2222-4222-8222-222222222222',
  displayName: 'TEST vendor',
  description: 'TEST',
  status: 'approved',
  createdAt: '2026-10-23T00:00:00.000Z',
  updatedAt: '2026-10-23T00:00:00.000Z',
};

/** A vendor read that answers one approved vendor; only the listing reads below reach the database. */
function vendorsWith(vendor: VendorRecord | null) {
  return partial<VendorService>({
    myVendor: async () => vendor,
    listingEligibility: async () => ({ vendorId: vendor?.id ?? '', listed: true }),
    entitledListingRefs: async () => new Set<string>(),
  });
}

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

  it('myListings refuses an unset limit and never reads without LIMIT', async () => {
    const { sql, queries } = recordingSql();
    const commerce = new CommerceService(sql, vendorsWith(APPROVED_VENDOR), new MemoryLedger(), { commissionBps: 500 });
    await expect(commerce.myListings(USER)).rejects.toMatchObject({ code: 'market.my_listings_list_limit_unset' });
    expect(queries).toEqual([]);

    await expect(commerce.myListings(USER, { limit: 50 })).resolves.toEqual([]);
    const read = queries.find((q) => q.text.includes('FROM market.listings'));
    expect(read?.text).toMatch(/LIMIT \$\d+$/);
    expect(read?.values.at(-1)).toBe(50);
    queries.length = 0;
    await commerce.myListings(USER, { limit: 500 });
    expect(queries.find((q) => q.text.includes('FROM market.listings'))?.values.at(-1)).toBe(50);
  });
});
