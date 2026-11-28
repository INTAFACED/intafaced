import { describe, expect, it } from 'vitest';
import { LIST_KB_LIMIT_UNSET, SupportError, SupportService, assertListKbLimit } from './support-service.js';
import { userCopy } from './user-copy.js';
import { callerAs } from './testing/router-caller.js';

/**
 * listKb page size is refuse-closed when unset.
 *
 * listKb called store.listPublishedKb() with no page, so omit dumped every
 * published article. Blank must refuse. Owner/client may pass 100 explicitly.
 */

describe('listKb limit unset refuse', () => {
  it('assertListKbLimit refuses blank / NaN / 0 — never invents 100', () => {
    expect(() => assertListKbLimit(undefined)).toThrow(SupportError);
    expect(() => assertListKbLimit(Number.NaN)).toThrow(SupportError);
    expect(() => assertListKbLimit(0)).toThrow(SupportError);
    try {
      assertListKbLimit(undefined);
      throw new Error('expected refuse');
    } catch (e) {
      expect(e).toBeInstanceOf(SupportError);
      expect((e as SupportError).code).toBe(LIST_KB_LIMIT_UNSET);
      expect((e as SupportError).message).not.toMatch(/100-row|default 100/i);
      expect(userCopy((e as SupportError).code)).toBe(LIST_KB_LIMIT_UNSET);
      expect(userCopy((e as SupportError).code)).not.toMatch(/100-row|default 100/i);
    }
  });

  it('accepts owner-published 100 and caps at existing door max 500', () => {
    expect(assertListKbLimit(100)).toBe(100);
    expect(assertListKbLimit(1)).toBe(1);
    expect(assertListKbLimit(500)).toBe(500);
    expect(assertListKbLimit(501)).toBe(500);
  });

  it('listKb omit refuses; explicit 100 pages; never dumps the catalog', async () => {
    const svc = new SupportService();
    await expect(svc.listKb()).rejects.toMatchObject({ code: LIST_KB_LIMIT_UNSET });
    await expect(svc.listKb({ limit: undefined })).rejects.toMatchObject({ code: LIST_KB_LIMIT_UNSET });
    const page = await svc.listKb({ limit: 100 });
    expect(page.length).toBeGreaterThanOrEqual(5);
    const one = await svc.listKb({ limit: 1 });
    expect(one).toHaveLength(1);
  });

  it('the listKb door refuses an omitted limit by name and pages an explicit one; it never dumps the catalog', async () => {
    const svc = new SupportService();
    const staff = await callerAs(svc, '33333333-3333-4333-8333-333333333333', ['support:ops', 'support:read', 'support:write']);
    for (const input of [undefined, {}]) {
      await expect(staff.listKb(input)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: userCopy(LIST_KB_LIMIT_UNSET) });
    }
    const all = await staff.listKb({ limit: 100 });
    expect(all.length).toBeGreaterThanOrEqual(5);
    expect(await staff.listKb({ limit: 1 })).toEqual(all.slice(0, 1));
  });
});
