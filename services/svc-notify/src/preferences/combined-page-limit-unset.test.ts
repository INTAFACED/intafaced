/**
 * Unit card — combined preference page refuses unpublished page size
 * (never invent all.length)
 *
 * 1. Promise: omit / NaN / 0 throws notify.combined_page_limit_unset.
 *    Owner-explicit limit still pages. No invented 20/50/100 cap.
 * 2. Break: `options.limit ?? all.length` / `?? plan.length` dumps the
 *    entire combined preference set nobody asked for.
 * 3. Done bar: unset throws NotifyCombinedPageLimitUnsetError; explicit
 *    page size is allowed
 * 4. Class N
 * 5. Paths: services/svc-notify/src/preferences/combined.ts
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COMBINED_PREFS,
  NotifyCombinedPageLimitUnsetError,
  NOTIFY_COMBINED_PAGE_LIMIT_UNSET,
  assertCombinedPageLimit,
  pagePlanDecisions,
  pagePlanSendChannels,
  planFanoutDelivery,
} from './combined.js';

describe('assertCombinedPageLimit', () => {
  it('refuses blank / NaN / 0 — never invents all.length', () => {
    expect(() => assertCombinedPageLimit(undefined)).toThrow(NotifyCombinedPageLimitUnsetError);
    expect(() => assertCombinedPageLimit(null)).toThrow(NotifyCombinedPageLimitUnsetError);
    expect(() => assertCombinedPageLimit(Number.NaN)).toThrow(NotifyCombinedPageLimitUnsetError);
    expect(() => assertCombinedPageLimit(0)).toThrow(NotifyCombinedPageLimitUnsetError);
    try {
      assertCombinedPageLimit(undefined);
      throw new Error('expected refuse');
    } catch (e) {
      expect(e).toBeInstanceOf(NotifyCombinedPageLimitUnsetError);
      expect((e as NotifyCombinedPageLimitUnsetError).code).toBe(NOTIFY_COMBINED_PAGE_LIMIT_UNSET);
      expect((e as NotifyCombinedPageLimitUnsetError).message).toBe(NOTIFY_COMBINED_PAGE_LIMIT_UNSET);
      expect((e as NotifyCombinedPageLimitUnsetError).message).not.toMatch(/all\.length|plan\.length|default 20|default 50|default 100/i);
    }
  });

  it('owner-explicit page size is allowed — no invented cap', () => {
    expect(assertCombinedPageLimit(1)).toBe(1);
    expect(assertCombinedPageLimit(2)).toBe(2);
    expect(assertCombinedPageLimit(20)).toBe(20);
    expect(assertCombinedPageLimit(50)).toBe(50);
    expect(assertCombinedPageLimit(100)).toBe(100);
    expect(assertCombinedPageLimit(101)).toBe(101);
  });
});

describe('pagePlanDecisions / pagePlanSendChannels limit unset refuse', () => {
  it('omit / NaN / 0 throws — does not dump the plan', () => {
    const plan = planFanoutDelivery(DEFAULT_COMBINED_PREFS, ['inapp', 'email', 'sms'], 'critical');
    expect(plan.length).toBeGreaterThan(1);
    expect(() => pagePlanDecisions(plan)).toThrow(NotifyCombinedPageLimitUnsetError);
    expect(() => pagePlanDecisions(plan, {})).toThrow(NotifyCombinedPageLimitUnsetError);
    expect(() => pagePlanDecisions(plan, { offset: 0 })).toThrow(NotifyCombinedPageLimitUnsetError);
    expect(() => pagePlanDecisions(plan, { limit: Number.NaN })).toThrow(NotifyCombinedPageLimitUnsetError);
    expect(() => pagePlanDecisions(plan, { limit: 0 })).toThrow(NotifyCombinedPageLimitUnsetError);
    expect(() => pagePlanSendChannels(plan)).toThrow(NotifyCombinedPageLimitUnsetError);
    expect(() => pagePlanSendChannels(plan, {})).toThrow(NotifyCombinedPageLimitUnsetError);
    expect(() => pagePlanSendChannels(plan, { limit: 0 })).toThrow(NotifyCombinedPageLimitUnsetError);
  });

  it('owner-explicit limit pages; does not return the whole set when limit < length', () => {
    const plan = planFanoutDelivery(DEFAULT_COMBINED_PREFS, ['inapp', 'email', 'sms'], 'critical');
    expect(pagePlanDecisions(plan, { offset: 0, limit: 2 })).toHaveLength(2);
    expect(pagePlanDecisions(plan, { limit: 1 })).toHaveLength(1);
    expect(pagePlanSendChannels(plan, { limit: 1 })).toHaveLength(1);
  });
});
