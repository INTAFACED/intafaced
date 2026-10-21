import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LIST_KB_LIMIT_UNSET, SupportError, SupportService, assertListKbLimit } from './support-service.js';
import { userCopy } from './user-copy.js';

/**
 * listKb page size is refuse-closed when unset.
 *
 * listKb called store.listPublishedKb() with no page, so omit dumped every
 * published article. Blank must refuse. Owner/client may pass 100 explicitly.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

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

  it('router does not invent 100 when listKb omits limit', () => {
    const src = readFileSync(join(ROOT, 'services/svc-support/src/router.ts'), 'utf8');
    const start = src.indexOf('listKb:');
    const end = src.indexOf('searchKb:', start);
    const fn = src.slice(start, end === -1 ? undefined : end);
    expect(fn).toContain('limit: input?.limit');
    expect(fn).not.toMatch(/input\?\.limit \?\? 100/);
    expect(fn).not.toMatch(/\?\? 100/);
  });

  it('listKb no longer dumps store.listPublishedKb() without a page', () => {
    const src = readFileSync(join(ROOT, 'services/svc-support/src/support-service.ts'), 'utf8');
    const start = src.indexOf('async listKb(');
    const end = src.indexOf('async searchKb(', start);
    const fn = src.slice(start, end === -1 ? undefined : end);
    expect(fn).toContain('assertListKbLimit');
    // The page is applied by the store together with the reader's audiences, so hidden articles take no place in it.
    expect(fn).toContain('this.store.listPublishedKb({ limit, audiences: audiencesFor(viewer) })');
    expect(fn).not.toMatch(/this\.store\.listPublishedKb\(\)/);
    expect(fn).not.toMatch(/\?\? 100/);
  });
});
