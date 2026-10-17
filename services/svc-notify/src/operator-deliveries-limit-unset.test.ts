/**
 * Unit card — operatorDeliveries refuses unpublished page size (never invent 50)
 *
 * 1. Promise: omit / NaN / 0 throws notify.operator_deliveries_limit_unset.
 *    Owner-explicit 50 still pages. Zod still caps 1..200.
 * 2. Break: `limit ?? 50` / `operatorDeliveryOutcomes(limit = 50)` publishes
 *    a 50-row ops page nobody asked for.
 * 3. Done bar: unset throws NotifyOperatorDeliveriesLimitUnsetError; 50 is allowed
 * 4. Class N
 * 5. Paths: services/svc-notify/src/notify-service.ts, router.ts
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  NotifyOperatorDeliveriesLimitUnsetError,
  NOTIFY_OPERATOR_DELIVERIES_LIMIT_UNSET,
  assertOperatorDeliveriesLimit,
} from './notify-service.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

describe('assertOperatorDeliveriesLimit', () => {
  it('refuses blank / NaN / 0 — never invents 50', () => {
    expect(() => assertOperatorDeliveriesLimit(undefined)).toThrow(NotifyOperatorDeliveriesLimitUnsetError);
    expect(() => assertOperatorDeliveriesLimit(null)).toThrow(NotifyOperatorDeliveriesLimitUnsetError);
    expect(() => assertOperatorDeliveriesLimit(Number.NaN)).toThrow(NotifyOperatorDeliveriesLimitUnsetError);
    expect(() => assertOperatorDeliveriesLimit(0)).toThrow(NotifyOperatorDeliveriesLimitUnsetError);
    try {
      assertOperatorDeliveriesLimit(undefined);
      throw new Error('expected refuse');
    } catch (e) {
      expect(e).toBeInstanceOf(NotifyOperatorDeliveriesLimitUnsetError);
      expect((e as NotifyOperatorDeliveriesLimitUnsetError).code).toBe(NOTIFY_OPERATOR_DELIVERIES_LIMIT_UNSET);
      expect((e as NotifyOperatorDeliveriesLimitUnsetError).message).toBe(NOTIFY_OPERATOR_DELIVERIES_LIMIT_UNSET);
      expect((e as NotifyOperatorDeliveriesLimitUnsetError).message).not.toMatch(/50-row|default 50/i);
    }
  });

  it('owner-explicit 50 is allowed and caps at 200', () => {
    expect(assertOperatorDeliveriesLimit(50)).toBe(50);
    expect(assertOperatorDeliveriesLimit(1)).toBe(1);
    expect(assertOperatorDeliveriesLimit(200)).toBe(200);
    expect(assertOperatorDeliveriesLimit(201)).toBe(200);
  });
});

describe('operatorDeliveries limit unset refuse — source pin', () => {
  it('router does not invent 50 when operatorDeliveries omits limit', () => {
    const src = readFileSync(join(ROOT, 'services/svc-notify/src/router.ts'), 'utf8');
    const start = src.indexOf('async function loadOperatorDeliveries');
    const end = src.indexOf('const priceAlertOutput', start);
    const fn = src.slice(start, end === -1 ? undefined : end);
    expect(fn).toContain('notify.operatorDeliveryOutcomes(limit, status)');
    expect(fn).not.toMatch(/limit \?\? 50/);
    expect(fn).not.toMatch(/\?\? 50/);
    expect(src).toContain('NotifyOperatorDeliveriesLimitUnsetError');
  });

  it('service default is not 50', () => {
    const src = readFileSync(join(ROOT, 'services/svc-notify/src/notify-service.ts'), 'utf8');
    expect(src).not.toMatch(/operatorDeliveryOutcomes\(limit = 50\)/);
    expect(src).toContain('assertOperatorDeliveriesLimit(limit)');
  });
});
