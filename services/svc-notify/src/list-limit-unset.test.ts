/**
 * Unit card — notify.list refuses unpublished page size (never invent 20)
 *
 * 1. Promise: omit / NaN / 0 throws notify.list_limit_unset. Owner-explicit 20
 *    still pages. Zod still caps 1..100.
 * 2. Break: `input?.limit ?? 20` publishes a 20-row inbox nobody asked for.
 * 3. Done bar: unset throws NotifyListLimitUnsetError; 20 is allowed
 * 4. Class N
 * 5. Paths: services/svc-notify/src/notify-service.ts, router.ts
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NotifyListLimitUnsetError, NOTIFY_LIST_LIMIT_UNSET, assertNotifyListLimit } from './notify-service.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

describe('assertNotifyListLimit', () => {
  it('refuses blank / NaN / 0 — never invents 20', () => {
    expect(() => assertNotifyListLimit(undefined)).toThrow(NotifyListLimitUnsetError);
    expect(() => assertNotifyListLimit(null)).toThrow(NotifyListLimitUnsetError);
    expect(() => assertNotifyListLimit(Number.NaN)).toThrow(NotifyListLimitUnsetError);
    expect(() => assertNotifyListLimit(0)).toThrow(NotifyListLimitUnsetError);
    try {
      assertNotifyListLimit(undefined);
      throw new Error('expected refuse');
    } catch (e) {
      expect(e).toBeInstanceOf(NotifyListLimitUnsetError);
      expect((e as NotifyListLimitUnsetError).code).toBe(NOTIFY_LIST_LIMIT_UNSET);
      expect((e as NotifyListLimitUnsetError).message).toBe(NOTIFY_LIST_LIMIT_UNSET);
      expect((e as NotifyListLimitUnsetError).message).not.toMatch(/20-row|default 20/i);
    }
  });

  it('owner-explicit 20 is allowed and caps at 100', () => {
    expect(assertNotifyListLimit(20)).toBe(20);
    expect(assertNotifyListLimit(1)).toBe(1);
    expect(assertNotifyListLimit(100)).toBe(100);
    expect(assertNotifyListLimit(101)).toBe(100);
  });
});

describe('notify.list limit unset refuse — source pin', () => {
  it('router does not invent 20 when notify.list omits limit', () => {
    const src = readFileSync(join(ROOT, 'services/svc-notify/src/router.ts'), 'utf8');
    const start = src.indexOf('list: mountRecord(\n        NOTIFY_LIST,');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('unreadCount:', start);
    const fn = src.slice(start, end === -1 ? undefined : end);
    expect(fn).toContain('assertNotifyListLimit(input?.limit)');
    expect(fn).not.toMatch(/input\?\.limit \?\? 20/);
    expect(fn).not.toMatch(/\?\? 20/);
  });
});
