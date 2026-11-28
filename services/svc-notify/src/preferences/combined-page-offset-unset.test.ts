/**
 * Unit card — combined preference page refuses a non-finite offset
 * (never an empty page, never an invented page size)
 *
 * 1. Promise: NaN / Infinity offset with a finite limit throws
 *    notify.combined_page_offset_unset. Omitted offset pages from 0.
 *    A finite offset still slices.
 * 2. Break: Math.max(0, Math.floor(NaN)) is NaN, and slice returns []
 *    even when the owner set a finite limit.
 * 3. Done bar: both page planners throw NotifyCombinedPageOffsetUnsetError;
 *    omitted and finite offsets still page.
 * 4. Class N
 * 5. Paths: services/svc-notify/src/preferences/combined.ts
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COMBINED_PREFS,
  NOTIFY_COMBINED_PAGE_OFFSET_UNSET,
  NotifyCombinedPageLimitUnsetError,
  NotifyCombinedPageOffsetUnsetError,
  assertCombinedPageOffset,
  channelsToSendNow,
  pagePlanDecisions,
  pagePlanSendChannels,
  planFanoutDelivery,
  safePagePlanDecisions,
} from './combined.js';

const NON_FINITE_OFFSETS = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY] as const;

function refusedOffset(run: () => unknown): Error & { code?: string } {
  try {
    const page = run();
    throw new Error(`returned a page: ${JSON.stringify(page)}`);
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('returned a page:')) throw e;
    return e as Error & { code?: string };
  }
}

describe('pagePlanDecisions / pagePlanSendChannels non-finite offset', () => {
  it('NaN or Infinity offset with a finite limit refuses and does not return an empty page', () => {
    const plan = planFanoutDelivery(DEFAULT_COMBINED_PREFS, ['inapp', 'email', 'sms'], 'critical');
    expect(plan.length).toBeGreaterThan(1);
    const sends = channelsToSendNow(plan);
    expect(sends.length).toBeGreaterThan(1);

    for (const offset of NON_FINITE_OFFSETS) {
      for (const run of [() => pagePlanDecisions(plan, { offset, limit: 1 }), () => pagePlanSendChannels(plan, { offset, limit: 1 })]) {
        const e = refusedOffset(run);
        expect(e).toBeInstanceOf(Error);
        expect(e).not.toBeInstanceOf(NotifyCombinedPageLimitUnsetError);
        expect(e.name).toBe('NotifyCombinedPageOffsetUnsetError');
        expect(e.code).toBe('notify.combined_page_offset_unset');
        expect(e.message).toBe('notify.combined_page_offset_unset');
      }
    }
  });

  it('omitted offset pages from 0; a finite offset still slices', () => {
    const plan = planFanoutDelivery(DEFAULT_COMBINED_PREFS, ['inapp', 'email', 'sms'], 'critical');
    const sends = channelsToSendNow(plan);
    expect(pagePlanDecisions(plan, { limit: 2 })).toEqual(plan.slice(0, 2));
    expect(pagePlanDecisions(plan, { offset: 0, limit: 2 })).toEqual(plan.slice(0, 2));
    expect(pagePlanDecisions(plan, { offset: 1, limit: 1 })).toEqual(plan.slice(1, 2));
    expect(pagePlanDecisions(plan, { offset: 1.9, limit: 1 })).toEqual(plan.slice(1, 2));
    expect(pagePlanSendChannels(plan, { limit: 2 })).toEqual(sends.slice(0, 2));
    expect(pagePlanSendChannels(plan, { offset: 0, limit: 1 })).toEqual(sends.slice(0, 1));
    expect(pagePlanSendChannels(plan, { offset: 1, limit: 1 })).toEqual(sends.slice(1, 2));
    expect(pagePlanDecisions(plan, { limit: 2 }).length).toBeGreaterThan(0);
    expect(pagePlanSendChannels(plan, { limit: 1 }).length).toBeGreaterThan(0);
  });
});

describe('combined page offset unset refuse', () => {
  it('both planners refuse a non-finite offset and do not invent a page size', () => {
    const plan = planFanoutDelivery(DEFAULT_COMBINED_PREFS, ['inapp', 'email', 'sms'], 'critical');
    // The offset is checked on its own: a non-finite one with a good limit refuses by the offset's name.
    for (const offset of NON_FINITE_OFFSETS) {
      expect(() => assertCombinedPageOffset(offset)).toThrow(NotifyCombinedPageOffsetUnsetError);
      expect(refusedOffset(() => pagePlanDecisions(plan, { offset, limit: plan.length }))).toBeInstanceOf(
        NotifyCombinedPageOffsetUnsetError,
      );
      expect(refusedOffset(() => pagePlanSendChannels(plan, { offset, limit: plan.length })).code).toBe(NOTIFY_COMBINED_PAGE_OFFSET_UNSET);
      // The clamped reader answers an empty page, never the whole plan.
      expect(safePagePlanDecisions(plan, offset, 2)).toEqual([]);
    }
    expect(safePagePlanDecisions(plan, 0, Number.POSITIVE_INFINITY)).toEqual([]);
    expect(safePagePlanDecisions(plan, 0, 2)).toEqual(plan.slice(0, 2));
    // An omitted offset is the first page (0), not a guessed size: the limit still decides the page.
    expect(pagePlanDecisions(plan, { limit: 1 })).toEqual(plan.slice(0, 1));
  });
});
