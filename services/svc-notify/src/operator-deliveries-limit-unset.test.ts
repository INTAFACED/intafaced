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
import { describe, expect, it } from 'vitest';
import {
  NotifyOperatorDeliveriesLimitUnsetError,
  NOTIFY_OPERATOR_DELIVERIES_LIMIT_UNSET,
  assertOperatorDeliveriesLimit,
} from './notify-service.js';

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
