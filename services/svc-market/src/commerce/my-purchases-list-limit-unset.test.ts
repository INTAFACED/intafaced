import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MarketError } from '../vendor-service.js';
import { userCopy } from '../user-copy.js';
import { assertMyPurchasesListLimit } from './commerce-service.js';

/**
 * myPurchases / purchasesOf page size is refuse-closed when unset.
 *
 * purchasesOf dumped every purchase for the buyer with no LIMIT.
 * Blank must refuse. Owner/client may pass 50 explicitly.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

describe('myPurchases limit unset refuse', () => {
  it('assertMyPurchasesListLimit refuses blank / NaN / 0 — never invents 50', () => {
    expect(() => assertMyPurchasesListLimit(undefined)).toThrow(MarketError);
    expect(() => assertMyPurchasesListLimit(Number.NaN)).toThrow(MarketError);
    expect(() => assertMyPurchasesListLimit(0)).toThrow(MarketError);
    try {
      assertMyPurchasesListLimit(undefined);
      throw new Error('expected refuse');
    } catch (e) {
      expect(e).toBeInstanceOf(MarketError);
      expect((e as MarketError).code).toBe('market.my_purchases_list_limit_unset');
      expect((e as MarketError).message).toBe(userCopy('market.my_purchases_list_limit_unset'));
      expect((e as MarketError).message).not.toMatch(/50-purchase|default 50/i);
    }
  });

  it('accepts owner-published 50 and caps at 50', () => {
    expect(assertMyPurchasesListLimit(50)).toBe(50);
    expect(assertMyPurchasesListLimit(1)).toBe(1);
    expect(assertMyPurchasesListLimit(20)).toBe(20);
    expect(assertMyPurchasesListLimit(51)).toBe(50);
  });

  it('purchasesOf no longer dumps without LIMIT', () => {
    const src = readFileSync(join(ROOT, 'services/svc-market/src/commerce/commerce-service.ts'), 'utf8');
    const start = src.indexOf('async purchasesOf(');
    const end = src.indexOf('async cancelSubscription(', start);
    const fn = src.slice(start, end === -1 ? undefined : end);
    expect(fn).toContain('assertMyPurchasesListLimit');
    expect(fn).toContain('LIMIT ${limit}');
    expect(fn).not.toMatch(/\?\? 50/);
  });

  it('router does not invent 50 when myPurchases omits limit', () => {
    const src = readFileSync(join(ROOT, 'services/svc-market/src/router.ts'), 'utf8');
    const start = src.indexOf('myPurchases: mountRecord(');
    const end = src.indexOf('cancelSubscription:', start);
    const fn = src.slice(start, end === -1 ? undefined : end);
    expect(fn).toContain('purchasesOf(ctx.principal.userId, { limit: input?.limit })');
    expect(fn).not.toMatch(/input\?\.limit \?\? 50/);
    expect(fn).not.toMatch(/\?\? 50/);
  });
});
