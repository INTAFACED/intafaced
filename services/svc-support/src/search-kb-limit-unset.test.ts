import { describe, expect, it } from 'vitest';
import { SUPPORT_SEARCH_KB } from '@intafaced/contracts/support-customer-procedures';
import { LIST_KB_LIMIT_UNSET, SupportError, SupportService, assertListKbLimit } from './support-service.js';
import { PLATFORM_KB_SPINE, searchKb } from './kb-catalog.js';
import { userCopy } from './user-copy.js';
import { callerAs } from './testing/router-caller.js';

/**
 * searchKb page size is refuse-closed when unset — same window as listKb.
 *
 * searchKb called store.listPublishedKb() with no page then returned the
 * whole catalog (empty q). Blank must refuse. Owner/client may pass 100
 * explicitly. Slice is after search so a match beyond the first N published
 * rows is not dropped.
 */

describe('searchKb limit unset refuse', () => {
  it('reuses listKb window — never invents 100', () => {
    expect(() => assertListKbLimit(undefined)).toThrow(SupportError);
    expect(assertListKbLimit(2)).toBe(2);
    expect(assertListKbLimit(500)).toBe(500);
    expect(assertListKbLimit(501)).toBe(500);
  });

  it('searchKb omit refuses; empty q does not dump the spine', async () => {
    const svc = new SupportService();
    await expect(svc.searchKb('')).rejects.toMatchObject({ code: LIST_KB_LIMIT_UNSET });
    await expect(svc.searchKb('account')).rejects.toMatchObject({ code: LIST_KB_LIMIT_UNSET });
    await expect(svc.searchKb('', { limit: undefined })).rejects.toMatchObject({ code: LIST_KB_LIMIT_UNSET });
    try {
      await svc.searchKb('');
      throw new Error('expected refuse');
    } catch (e) {
      expect(e).toBeInstanceOf(SupportError);
      expect((e as SupportError).code).toBe(LIST_KB_LIMIT_UNSET);
      expect(userCopy((e as SupportError).code)).toBe(LIST_KB_LIMIT_UNSET);
      expect(userCopy((e as SupportError).code)).not.toMatch(/100-row|default 100/i);
    }
  });

  it('published limit 2 slices after search; empty q pages the catalog', async () => {
    const svc = new SupportService();
    const listed = await svc.listKb({ limit: 2 });
    const emptyQ = await svc.searchKb('', { limit: 2 });
    expect(emptyQ).toHaveLength(2);
    expect(emptyQ).toEqual(listed);
    const hits = await svc.searchKb('account', { limit: 2 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.length).toBeLessThanOrEqual(2);
  });

  it('empty catalog stays []; empty matches stay [] — not 404', async () => {
    const svc = new SupportService();
    for (const article of await svc.listKb({ limit: 500 })) {
      await svc.unpublishKb({ id: article.id, baseRevision: 1 });
    }
    expect(await svc.searchKb('', { limit: 100 })).toEqual([]);
    expect(await svc.searchKb('account', { limit: 100 })).toEqual([]);
    expect(await svc.searchKb('definitely-not-an-article-xyz', { limit: 100 })).toEqual([]);
  });

  it('pure catalog helper still searches a passed-in array without a door limit', () => {
    expect(searchKb('').length).toBe(PLATFORM_KB_SPINE.length);
    expect(searchKb('', [])).toEqual([]);
    expect(searchKb('account', PLATFORM_KB_SPINE).some((a) => a.id === 'kb-account-access')).toBe(true);
  });

  it('the searchKb door refuses an omitted limit by name and pages the hits after searching', async () => {
    // The record the door is mounted from names the refusal and leaves the page size optional, so a blank reaches it.
    expect(SUPPORT_SEARCH_KB.refusals['support.list_kb_limit_unset']).toBe('PRECONDITION_FAILED');
    expect(SUPPORT_SEARCH_KB.input.safeParse({ q: '' }).success).toBe(true);
    const svc = new SupportService();
    const staff = await callerAs(svc, '33333333-3333-4333-8333-333333333333', ['support:ops', 'support:read', 'support:write']);
    for (const input of [undefined, { q: '' }, { q: 'account' }]) {
      await expect(staff.searchKb(input)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: userCopy(LIST_KB_LIMIT_UNSET) });
    }
    expect((await staff.searchKb({ q: 'account', limit: 100 })).some((a) => a.id === 'kb-account-access')).toBe(true);
    const all = await staff.searchKb({ q: '', limit: 100 });
    expect(all.length).toBeGreaterThan(1);
    expect(await staff.searchKb({ q: '', limit: 1 })).toEqual(all.slice(0, 1));
    expect(await staff.searchKb({ q: '', limit: 2 })).toEqual(await svc.listKb({ limit: 2 }));
  });
});
