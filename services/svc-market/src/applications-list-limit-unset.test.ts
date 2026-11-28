import { describe, expect, it } from 'vitest';
import { MarketError, assertApplicationsListLimit } from './vendor-service.js';
import { userCopy } from './user-copy.js';

/**
 * listApplications page size is refuse-closed when unset.
 *
 * listApplications used `options.limit ?? 50`, so omit invented a 50-application page.
 * Blank must refuse. Owner/client may pass 50 explicitly.
 */

describe('listApplications limit unset refuse', () => {
  it('assertApplicationsListLimit refuses blank / NaN / 0 — never invents 50', () => {
    expect(() => assertApplicationsListLimit(undefined)).toThrow(MarketError);
    expect(() => assertApplicationsListLimit(Number.NaN)).toThrow(MarketError);
    expect(() => assertApplicationsListLimit(0)).toThrow(MarketError);
    try {
      assertApplicationsListLimit(undefined);
      throw new Error('expected refuse');
    } catch (e) {
      expect(e).toBeInstanceOf(MarketError);
      expect((e as MarketError).code).toBe('market.applications_list_limit_unset');
      expect((e as MarketError).message).toBe(userCopy('market.applications_list_limit_unset'));
      expect((e as MarketError).message).not.toMatch(/50-application|default 50/i);
    }
  });

  it('accepts owner-published 50 and caps at 50', () => {
    expect(assertApplicationsListLimit(50)).toBe(50);
    expect(assertApplicationsListLimit(1)).toBe(1);
    expect(assertApplicationsListLimit(20)).toBe(20);
    expect(assertApplicationsListLimit(51)).toBe(50);
  });
});
