import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MarketError, assertListedVendorsListLimit } from './vendor-service.js';
import { userCopy } from './user-copy.js';

/**
 * listedVendors page size is refuse-closed when unset.
 *
 * listedVendors used `options.limit ?? 20`, so omit invented a 20-vendor page.
 * Blank must refuse. Owner/client may pass 20 explicitly.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

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

  it('listedVendors no longer defaults limit to 20', () => {
    const src = readFileSync(join(ROOT, 'services/svc-market/src/vendor-service.ts'), 'utf8');
    const start = src.indexOf('async listedVendors(');
    const fn = src.slice(start);
    expect(fn).toContain('assertListedVendorsListLimit');
    expect(fn).not.toMatch(/\?\? 20/);
  });

  it('router does not invent 20 when listed omits limit', () => {
    const src = readFileSync(join(ROOT, 'services/svc-market/src/router.ts'), 'utf8');
    const start = src.indexOf('listed: publicProcedure');
    const end = src.indexOf('history:', start);
    const fn = src.slice(start, end === -1 ? undefined : end);
    expect(fn).toContain('listedVendors({ limit: input?.limit, signal })');
    expect(fn).not.toMatch(/input\?\.limit \?\? 20/);
    expect(fn).not.toMatch(/\?\? 20/);
  });
});
