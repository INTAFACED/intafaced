import { describe, expect, it } from 'vitest';
import {
  assertMayOpenDispute,
  assertUnderCaps,
  assertWithinWindow,
  describePolicy,
  DisputeOpenError,
  parseDisputePolicy,
  type DisputePolicy,
} from './dispute-open-policy.js';
import { TRADE_STATUSES } from './state.js';

const WINDOWS_OFF = {
  earliestAfterCreatedSeconds: 'off',
  latestAfterCreatedSeconds: 'off',
  earliestAfterFiatSentSeconds: 'off',
  latestAfterFiatSentSeconds: 'off',
};
const NONE = parseDisputePolicy(WINDOWS_OFF);
const T0 = new Date('2026-10-22T00:00:00Z');
const at = (s: number) => new Date(T0.getTime() + s * 1000);
const trade = { status: 'fiat_sent' as const, buyerId: 'b', sellerId: 's', createdAt: T0, fiatSentAt: at(60) };
const noHistory = { openedByUserLastDay: [], openedOnThisOrder: [] };

function err(fn: () => unknown): DisputeOpenError | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof DisputeOpenError) return e;
    throw e;
  }
  return undefined;
}

describe('P-disputes-security-01 open policy', () => {
  it('buyer opens "seller did not release" on fiat_sent with no caps set', () => {
    expect(
      assertMayOpenDispute({ policy: NONE, trade, userId: 'b', reasonCode: 'seller_did_not_release', history: noHistory, now: at(120) }),
    ).toEqual({ role: 'buyer', reasonCode: 'seller_did_not_release' });
  });

  it('a seller picking a buyer-only reason refuses p2p.reason_invalid', () => {
    const e = err(() =>
      assertMayOpenDispute({ policy: NONE, trade, userId: 's', reasonCode: 'seller_did_not_release', history: noHistory, now: at(120) }),
    );
    expect(e?.code).toBe('p2p.reason_invalid');
  });

  it('missing or unknown reason refuses', () => {
    for (const r of [undefined, '', 'free text', 42]) {
      expect(
        err(() => assertMayOpenDispute({ policy: NONE, trade, userId: 'b', reasonCode: r, history: noHistory, now: at(1) }))?.code,
      ).toBe('p2p.reason_invalid');
    }
  });

  it('only escrowed and fiat_sent are openable; every other status refuses p2p.dispute_not_allowed', () => {
    for (const status of TRADE_STATUSES) {
      const e = err(() =>
        assertMayOpenDispute({
          policy: NONE,
          trade: { ...trade, status },
          userId: 'b',
          reasonCode: 'other',
          history: noHistory,
          now: at(120),
        }),
      );
      if (status === 'escrowed' || status === 'fiat_sent') expect(e).toBeUndefined();
      else expect(e?.code).toBe('p2p.dispute_not_allowed');
    }
  });

  it('a non-party refuses p2p.dispute_not_allowed', () => {
    expect(
      err(() => assertMayOpenDispute({ policy: NONE, trade, userId: 'x', reasonCode: 'other', history: noHistory, now: at(1) }))?.code,
    ).toBe('p2p.dispute_not_allowed');
    expect(
      err(() => assertMayOpenDispute({ policy: NONE, trade, userId: '', reasonCode: 'other', history: noHistory, now: at(1) }))?.code,
    ).toBe('p2p.dispute_not_allowed');
  });

  it('windows off and caps blank read "rule off" and "no cap set"', () => {
    const d = describePolicy(NONE);
    expect([d.earliestAfterCreatedSeconds, d.latestAfterFiatSentSeconds]).toEqual(['rule off', 'rule off']);
    expect([d.perDayCap, d.perOrderCap, d.resubmissionWaitSeconds]).toEqual(['no cap set', 'no cap set', 'no cap set']);
    expect(describePolicy(parseDisputePolicy({ ...WINDOWS_OFF, perDayCap: '3' })).perDayCap).toBe(3);
  });

  it('a garbled owner value refuses p2p.config_unset instead of becoming no cap', () => {
    for (const v of ['abc', -1, 1.5, '1e3', NaN]) {
      expect(err(() => parseDisputePolicy({ ...WINDOWS_OFF, perDayCap: v }))?.code).toBe('p2p.config_unset');
    }
  });

  it('windows: too early returns retryAt, too late refuses, fiat_sent anchor required when set', () => {
    const p: DisputePolicy = { ...NONE, earliestAfterCreatedSeconds: 300, latestAfterCreatedSeconds: 3600 };
    const early = err(() => assertWithinWindow(p, trade, at(100)));
    expect(early?.code).toBe('p2p.dispute_window_closed');
    expect(early?.retryAt).toEqual(at(300));
    expect(err(() => assertWithinWindow(p, trade, at(3601)))?.code).toBe('p2p.dispute_window_closed');
    expect(err(() => assertWithinWindow(p, trade, at(1000)))).toBeUndefined();
    const f: DisputePolicy = { ...NONE, earliestAfterFiatSentSeconds: 60 };
    expect(err(() => assertWithinWindow(f, { createdAt: T0, fiatSentAt: null }, at(9999)))?.code).toBe('p2p.dispute_window_closed');
    expect(err(() => assertWithinWindow(f, trade, at(119)))?.code).toBe('p2p.dispute_window_closed');
    expect(err(() => assertWithinWindow(f, trade, at(120)))).toBeUndefined();
  });

  it('caps set and exceeded refuse p2p.dispute_cap_reached with a reset time', () => {
    const now = at(86_400);
    const day = err(() =>
      assertUnderCaps({ ...NONE, perDayCap: 2 }, { openedByUserLastDay: [at(1000), at(5000)], openedOnThisOrder: [] }, now),
    );
    expect(day?.code).toBe('p2p.dispute_cap_reached');
    expect(day?.retryAt).toEqual(at(1000 + 86_400));
    // An open older than 24h no longer counts.
    expect(
      err(() => assertUnderCaps({ ...NONE, perDayCap: 1 }, { openedByUserLastDay: [at(0)], openedOnThisOrder: [] }, now)),
    ).toBeUndefined();
    expect(
      err(() => assertUnderCaps({ ...NONE, perOrderCap: 1 }, { openedByUserLastDay: [], openedOnThisOrder: [at(10)] }, now))?.code,
    ).toBe('p2p.dispute_cap_reached');
    const wait = err(() =>
      assertUnderCaps({ ...NONE, resubmissionWaitSeconds: 600 }, { openedByUserLastDay: [], openedOnThisOrder: [at(86_000)] }, now),
    );
    expect(wait?.retryAt).toEqual(at(86_600));
    expect(
      err(() => assertUnderCaps(NONE, { openedByUserLastDay: [at(1), at(2), at(3)], openedOnThisOrder: [at(1)] }, now)),
    ).toBeUndefined();
  });
});
