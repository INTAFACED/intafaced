import { describe, expect, it } from 'vitest';
import { recordingSql } from './sql-recorder.testkit.js';
import { MarketError, VendorService, assertListedVendorsListLimit } from './vendor-service.js';
import { userCopy } from './user-copy.js';

/**
 * listedVendors page size is refuse-closed when unset.
 *
 * listedVendors used `options.limit ?? 20`, so omit invented a 20-vendor page.
 * Blank must refuse. Owner/client may pass 20 explicitly.
 */

describe('listedVendors limit unset refuse', () => {
  it('assertListedVendorsListLimit refuses blank / NaN / 0 — never invents 20', () => {
    expect(() => assertListedVendorsListLimit(undefined)).toThrow(MarketError);
    expect(() => assertListedVendorsListLimit(Number.NaN)).toThrow(MarketError);
    expect(() => assertListedVendorsListLimit(0)).toThrow(MarketError);
    try {
      assertListedVendorsListLimit(undefined);
      throw new Error('expected refuse');
    } catch (e) {
      expect(e).toBeInstanceOf(MarketError);
      expect((e as MarketError).code).toBe('market.listed_vendors_list_limit_unset');
      expect((e as MarketError).message).toBe(userCopy('market.listed_vendors_list_limit_unset'));
      expect((e as MarketError).message).not.toMatch(/20-vendor|default 20/i);
    }
  });

  it('accepts owner-published 20 and caps at 50', () => {
    expect(assertListedVendorsListLimit(20)).toBe(20);
    expect(assertListedVendorsListLimit(1)).toBe(1);
    expect(assertListedVendorsListLimit(50)).toBe(50);
    expect(assertListedVendorsListLimit(51)).toBe(50);
  });

  it('listedVendors refuses an unset limit before reading, and asks the database for no more than the published page', async () => {
    const { sql, queries } = recordingSql();
    const vendors = new VendorService(sql, { entitlementOf: async () => ({ tierName: 'TEST', vendorSlots: 1 }) });
    await expect(vendors.listedVendors()).rejects.toMatchObject({ code: 'market.listed_vendors_list_limit_unset' });
    await expect(vendors.listedVendors({})).rejects.toMatchObject({ code: 'market.listed_vendors_list_limit_unset' });
    expect(queries).toEqual([]);

    await expect(vendors.listedVendors({ limit: 20 })).resolves.toEqual([]);
    const page = queries.find((q) => q.text.includes('FROM market.vendors v'));
    expect(page?.text).toMatch(/LIMIT \$\d+$/);
    expect(page?.values.at(-1)).toBe(20);
    queries.length = 0;
    await vendors.listedVendors({ limit: 500 });
    expect(queries.find((q) => q.text.includes('FROM market.vendors v'))?.values.at(-1)).toBe(50);
  });
});
