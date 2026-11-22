import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MarketError, assertApplicationsListLimit } from './vendor-service.js';
import { userCopy } from './user-copy.js';

/**
 * listApplications page size is refuse-closed when unset.
 *
 * listApplications used `options.limit ?? 50`, so omit invented a 50-application page.
 * Blank must refuse. Owner/client may pass 50 explicitly.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

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

  it('listApplications no longer defaults limit to 50', () => {
    const src = readFileSync(join(ROOT, 'services/svc-market/src/vendor-service.ts'), 'utf8');
    const start = src.indexOf('async listApplications(');
    const end = src.indexOf('async vet(', start);
    const fn = src.slice(start, end === -1 ? undefined : end);
    expect(fn).toContain('assertApplicationsListLimit');
    expect(fn).not.toMatch(/\?\? 50/);
  });

  it('router does not invent 50 when listApplications omits limit', () => {
    const src = readFileSync(join(ROOT, 'services/svc-market/src/router.ts'), 'utf8');
    const start = src.indexOf('listApplications: mountRecord(');
    const end = src.indexOf('vet: mountRecord(', start);
    const fn = src.slice(start, end === -1 ? undefined : end);
    expect(fn).toContain('limit: input?.limit');
    expect(fn).not.toMatch(/input\?\.limit \?\? 50/);
    expect(fn).not.toMatch(/\?\? 50/);
  });
});
