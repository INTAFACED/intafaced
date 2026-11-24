/**
 * Unit card — notify.alerts refuses unpublished page size (never invent 20)
 *
 * 1. Promise: omit / NaN / 0 throws notify.alerts_list_limit_unset. Owner-explicit 20
 *    still pages. Zod still caps 1..100.
 * 2. Break: `alerts.list(userId)` with no page size dumps every watch.
 * 3. Done bar: unset throws NotifyAlertsListLimitUnsetError; 20 is allowed
 * 4. Class N
 * 5. Paths: services/svc-notify/src/alerts/service.ts, router.ts
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NotifyAlertsListLimitUnsetError, NOTIFY_ALERTS_LIST_LIMIT_UNSET, assertNotifyAlertsListLimit } from './service.js';
import { MemoryAlertStore } from './store.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

describe('assertNotifyAlertsListLimit', () => {
  it('refuses blank / NaN / 0 — never invents 20', () => {
    expect(() => assertNotifyAlertsListLimit(undefined)).toThrow(NotifyAlertsListLimitUnsetError);
    expect(() => assertNotifyAlertsListLimit(null)).toThrow(NotifyAlertsListLimitUnsetError);
    expect(() => assertNotifyAlertsListLimit(Number.NaN)).toThrow(NotifyAlertsListLimitUnsetError);
    expect(() => assertNotifyAlertsListLimit(0)).toThrow(NotifyAlertsListLimitUnsetError);
    try {
      assertNotifyAlertsListLimit(undefined);
      throw new Error('expected refuse');
    } catch (e) {
      expect(e).toBeInstanceOf(NotifyAlertsListLimitUnsetError);
      expect((e as NotifyAlertsListLimitUnsetError).code).toBe(NOTIFY_ALERTS_LIST_LIMIT_UNSET);
      expect((e as NotifyAlertsListLimitUnsetError).message).toBe(NOTIFY_ALERTS_LIST_LIMIT_UNSET);
      expect((e as NotifyAlertsListLimitUnsetError).message).not.toMatch(/20-row|default 20/i);
    }
  });

  it('owner-explicit 20 is allowed and caps at 100', () => {
    expect(assertNotifyAlertsListLimit(20)).toBe(20);
    expect(assertNotifyAlertsListLimit(1)).toBe(1);
    expect(assertNotifyAlertsListLimit(100)).toBe(100);
    expect(assertNotifyAlertsListLimit(101)).toBe(100);
  });
});

describe('MemoryAlertStore.list pages when limit is set', () => {
  it('explicit 1 does not dump both watches', async () => {
    const store = new MemoryAlertStore();
    await store.create({ userId: 'u1', marketId: 'BTC-USD', direction: 'above', targetPrice: '100' });
    await store.create({ userId: 'u1', marketId: 'ETH-USD', direction: 'below', targetPrice: '200' });
    expect(await store.list('u1')).toHaveLength(2);
    expect(await store.list('u1', 1)).toHaveLength(1);
  });
});

describe('notify.alerts limit unset refuse — source pin', () => {
  it('router does not dump every watch when notify.alerts omits limit', () => {
    const src = readFileSync(join(ROOT, 'services/svc-notify/src/router.ts'), 'utf8');
    const start = src.indexOf('alerts: mountRecord(');
    const end = src.indexOf('createAlert: mountRecord(', start);
    const fn = src.slice(start, end === -1 ? undefined : end);
    expect(fn).toContain('assertNotifyAlertsListLimit(input?.limit)');
    expect(fn).toContain('alerts.list(ctx.principal.userId, limit)');
    expect(fn).not.toMatch(/alerts\.list\(ctx\.principal\.userId\)/);
    expect(fn).not.toMatch(/input\?\.limit \?\? 20/);
    expect(fn).not.toMatch(/\?\? 20/);
    expect(fn).not.toMatch(/\?\? 50/);
  });
});
