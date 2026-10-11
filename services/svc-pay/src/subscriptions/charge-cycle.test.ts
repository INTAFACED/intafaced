import { describe, expect, it } from 'vitest';
import { parseAmount as amt } from '@intafaced/ledger-client';
import { PayError } from '../payment-service.js';
import {
  MAX_ATTEMPTS_PER_CYCLE,
  assertKeyedByPeriod,
  assertWithinMandateCeiling,
  assertWithinMandateWindow,
  chargeIdempotencyKey,
  invoiceExpiredAt,
  lastAuthorisedOccurrence,
  mandateChargeCeiling,
  occurrenceDueAt,
  planChargeCycle,
  projectReAnchor,
  resolveSubscriptionFeeBps,
  retryDueAt,
  type CycleFrame,
  type LastCycle,
} from './charge-cycle.js';
import { MAX_CATCH_UP_PER_PASS, planDue } from './schedule.js';

/**
 * THE CHARGE CYCLE'S LAW, with no database in the way.
 *
 * Every test here corresponds to a ruling, and the header of `charge-cycle.ts`
 * argues each one. The DB-and-ledger half is `charge-cycle.db.test.ts`, which
 * asserts on BALANCES; this file asserts on the decisions that lead to them,
 * because a planner that can be made to return two charges is a double-charge
 * whatever the money path does afterwards.
 */

const SUB = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const utc = (y: number, m: number, d: number, h = 0) => new Date(Date.UTC(y, m - 1, d, h, 0, 0, 0));

function frame(overrides: Partial<CycleFrame> = {}): CycleFrame {
  return {
    cadence: 'monthly',
    mandateStartsAt: utc(2026, 1, 1),
    mandateEndsAt: null,
    anchorAt: null,
    anchorOccurrence: 0,
    ...overrides,
  };
}

function settled(occurrence: number): LastCycle {
  return { occurrence, status: 'settled', attemptCount: 1, exhausted: false, lastAttemptAt: null };
}

function rejected(occurrence: number, attemptCount = 1, exhausted = false): LastCycle {
  return { occurrence, status: 'rejected', attemptCount, exhausted, lastAttemptAt: null };
}

// ── 1. IDEMPOTENCY PER BUSINESS EVENT, NEVER PER ATTEMPT ────────────────────

describe('the business idempotency key is the PERIOD', () => {
  it('is (subscription, occurrence) and nothing else', () => {
    expect(chargeIdempotencyKey({ subscriptionId: SUB, occurrence: 0 })).toBe(`pay.subscription:${SUB}:0`);
    expect(chargeIdempotencyKey({ subscriptionId: SUB, occurrence: 7 })).toBe(`pay.subscription:${SUB}:7`);
  });

  /**
   * The whole point. Two calls at different instants, in different processes,
   * on different days must produce the SAME string — otherwise a retry is a
   * second charge. `close:${positionId}` survived here;
   * `close:${id}:${randomUUID()}` drained a pot.
   */
  it('is byte-identical across attempts — the clock cannot get into it', () => {
    const first = chargeIdempotencyKey({ subscriptionId: SUB, occurrence: 3 });
    const later = chargeIdempotencyKey({ subscriptionId: SUB, occurrence: 3 });
    expect(later).toBe(first);
    // And nothing clock-shaped or random-shaped is in it.
    expect(() => assertKeyedByPeriod(first, SUB)).not.toThrow();
  });

  it('DIFFERENT periods get different keys — dedupe must not swallow next month', () => {
    const january = chargeIdempotencyKey({ subscriptionId: SUB, occurrence: 0 });
    const february = chargeIdempotencyKey({ subscriptionId: SUB, occurrence: 1 });
    expect(new Set([january, february]).size).toBe(2);
  });

  it('REFUSES the shapes that made a retry charge twice', () => {
    // The literal defect: an extra per-attempt token appended to a correct key.
    const perAttempt = `pay.subscription:${SUB}:3:0f5c9a1e-2b7d-4a3c-9e1f-8d6b4c2a0e77`;
    expect(() => assertKeyedByPeriod(perAttempt, SUB)).toThrow(PayError);
    expect(() => assertKeyedByPeriod(`pay.subscription:${SUB}:3:2026-08-09T12:30:00.000Z`, SUB)).toThrow(/clock reading|ISO/i);
    expect(() => assertKeyedByPeriod(`pay.subscription:${SUB}:3:1786000000000`, SUB)).toThrow(/clock reading/i);
  });

  it('does not mistake the subscription id itself for a per-attempt token', () => {
    // A correct key CONTAINS a UUID — the subscription's. That must be fine, or
    // the guard would refuse every legitimate key and get deleted.
    expect(() => assertKeyedByPeriod(chargeIdempotencyKey({ subscriptionId: SUB, occurrence: 1 }), SUB)).not.toThrow();
  });

  it('refuses to key a period that is not a period', () => {
    expect(() => chargeIdempotencyKey({ subscriptionId: SUB, occurrence: -1 })).toThrow(PayError);
    expect(() => chargeIdempotencyKey({ subscriptionId: SUB, occurrence: 1.5 })).toThrow(PayError);
    expect(() => chargeIdempotencyKey({ subscriptionId: '  ', occurrence: 0 })).toThrow(PayError);
  });
});

// ── 2. THE INTERVAL IS THE PROMISE ──────────────────────────────────────────

describe('a paused or stalled schedule does not compress (TWAP ADR)', () => {
  /**
   * THE MEASUREMENT, in the subscription's units.
   *
   * The TWAP ADR measured "9 slices in 8 seconds" on an engine whose due times
   * were fixed at creation. `planDue` — the shape this engine used to run on —
   * has exactly that behaviour, and this test pins the contrast rather than
   * describing it: the old planner returns a wall of charges for a four-month
   * gap; the new one returns one.
   */
  it('planDue would fire FOUR months at once; planChargeCycle fires ONE', () => {
    const old = planDue({
      startsAt: utc(2026, 1, 1),
      cadence: 'monthly',
      endsAt: null,
      lastFired: 0,
      now: utc(2026, 5, 1),
    });
    expect(old.occurrences.length).toBeGreaterThan(1);
    expect(old.occurrences).toEqual([1, 2, 3, 4]);

    const plan = planChargeCycle({ frame: frame(), last: settled(0), now: utc(2026, 5, 1) });
    expect(plan.kind).toBe('charge');
    if (plan.kind !== 'charge') throw new Error('unreachable');
    expect(plan.occurrence).toBe(1);
    // Being four months late is RECORDED, not silently absorbed.
    expect(plan.lateIntervals).toBeGreaterThanOrEqual(3);
  });

  /** There is no input that produces two charges. That is the guarantee. */
  it('never returns more than one action, however long the gap', () => {
    for (const gapYears of [1, 2, 5, 20]) {
      const plan = planChargeCycle({ frame: frame(), last: settled(0), now: utc(2026 + gapYears, 5, 1) });
      expect(plan.kind).toBe('charge');
      if (plan.kind !== 'charge') throw new Error('unreachable');
      expect(plan.occurrence).toBe(1);
      expect(plan.reAnchor).not.toBeNull();
    }
  });

  /**
   * The re-anchor is the mechanism, and this is the assertion that would go red
   * if someone "simplified" it away: after a late charge, the NEXT period is a
   * full interval from now — not a date already in the past, which the very next
   * pass would fire and turn back into a burst.
   */
  it('re-anchors so the next period is a full interval after the resume instant', () => {
    const resumeAt = utc(2026, 5, 1);
    const plan = planChargeCycle({ frame: frame(), last: settled(0), now: resumeAt });
    if (plan.kind !== 'charge') throw new Error('expected a charge');
    expect(plan.reAnchor).toEqual({ at: resumeAt, occurrence: 1 });
    expect(plan.nextRunAt.toISOString()).toBe(utc(2026, 6, 1).toISOString());
    expect(plan.nextRunAt.getTime()).toBeGreaterThan(resumeAt.getTime());
  });

  it('a resumed frame then runs one period per interval, not back-to-back', () => {
    const resumed = frame({ anchorAt: utc(2026, 5, 1), anchorOccurrence: 1 });

    // Immediately after the resume charge: period 2 is not due.
    const idle = planChargeCycle({ frame: resumed, last: settled(1), now: utc(2026, 5, 1) });
    expect(idle.kind).toBe('idle');
    expect(idle.nextRunAt.toISOString()).toBe(utc(2026, 6, 1).toISOString());

    // Half a month later: still not due. The interval is the promise.
    expect(planChargeCycle({ frame: resumed, last: settled(1), now: utc(2026, 5, 15) }).kind).toBe('idle');

    // A month later: due, and ON TIME — no second re-anchor.
    const due = planChargeCycle({ frame: resumed, last: settled(1), now: utc(2026, 6, 1) });
    if (due.kind !== 'charge') throw new Error('expected a charge');
    expect(due.occurrence).toBe(2);
    expect(due.lateIntervals).toBe(0);
    expect(due.reAnchor).toBeNull();
  });

  it('an on-time charge does NOT move the frame', () => {
    const plan = planChargeCycle({ frame: frame(), last: settled(0), now: utc(2026, 2, 1) });
    if (plan.kind !== 'charge') throw new Error('expected a charge');
    expect(plan.reAnchor).toBeNull();
    expect(plan.lateIntervals).toBe(0);
    expect(plan.periodStart.toISOString()).toBe(utc(2026, 2, 1).toISOString());
  });

  it('is idle before the mandate starts, and says when to look again', () => {
    const plan = planChargeCycle({ frame: frame(), last: null, now: utc(2025, 12, 1) });
    expect(plan.kind).toBe('idle');
    expect(plan.nextRunAt.toISOString()).toBe(utc(2026, 1, 1).toISOString());
  });
});

// ── 3. A MISSED CYCLE IS NOT A SKIPPED CYCLE ────────────────────────────────

describe('an unsettled period blocks the next one (funding ADR §Funding)', () => {
  /**
   * *"A period that cannot be settled blocks the next one rather than being
   * silently skipped, because compounding a gap changes what every subsequent
   * position paid."* The subscription reading: a failed charge does NOT let next
   * month fall due, because then the customer owes two months and was told
   * about neither.
   */
  it('does not let the next period fall due while one is unsettled', () => {
    // February is rejected. It is now June. The old rule would have fired
    // March, April, May and June.
    const plan = planChargeCycle({ frame: frame(), last: rejected(1), now: utc(2026, 6, 1) });
    expect(plan.kind).toBe('retry');
    if (plan.kind !== 'retry') throw new Error('unreachable');
    // The SAME period, not the next one.
    expect(plan.occurrence).toBe(1);
  });

  it('retries the same period under the same key, up to the bound', () => {
    const first = planChargeCycle({ frame: frame(), last: rejected(1, 1), now: utc(2026, 6, 1) });
    const second = planChargeCycle({ frame: frame(), last: rejected(1, 2), now: utc(2026, 6, 1) });
    expect(first.kind).toBe('retry');
    expect(second.kind).toBe('retry');
    if (first.kind !== 'retry' || second.kind !== 'retry') throw new Error('unreachable');
    expect(first.occurrence).toBe(second.occurrence);
    expect(chargeIdempotencyKey({ subscriptionId: SUB, occurrence: first.occurrence })).toBe(
      chargeIdempotencyKey({ subscriptionId: SUB, occurrence: second.occurrence }),
    );
    expect(second.attempt).toBe(3);
  });

  it('STALLS in arrears once the attempts are spent — it never rolls forward', () => {
    const plan = planChargeCycle({ frame: frame(), last: rejected(1, MAX_ATTEMPTS_PER_CYCLE), now: utc(2026, 6, 1) });
    expect(plan).toMatchObject({ kind: 'blocked', occurrence: 1, reason: 'arrears' });
  });

  it('an exhausted period stays blocked even below the attempt bound', () => {
    // Terminal for a reason retrying cannot fix — an unauthorised amount.
    const plan = planChargeCycle({ frame: frame(), last: rejected(1, 1, true), now: utc(2026, 6, 1) });
    expect(plan).toMatchObject({ kind: 'blocked', reason: 'arrears' });
  });

  it('an invoice awaiting payment blocks the next period too', () => {
    const awaiting: LastCycle = { occurrence: 1, status: 'invoiced', attemptCount: 1, exhausted: false, lastAttemptAt: null };
    const plan = planChargeCycle({ frame: frame(), last: awaiting, now: utc(2026, 6, 1) });
    // Not a charge of period 2 — an unpaid invoice is not a settled period.
    expect(plan.kind).not.toBe('charge');
    expect(plan.kind === 'retry' ? plan.occurrence : null).toBe(1);
  });

  it('an unpaid invoice expires after one full interval, not never', () => {
    const f = frame();
    expect(invoiceExpiredAt(f, 0).toISOString()).toBe(utc(2026, 2, 1).toISOString());
    expect(invoiceExpiredAt(f, 1).toISOString()).toBe(utc(2026, 3, 1).toISOString());
  });

  it('retry slots stay inside the period they belong to', () => {
    const f = frame({ cadence: 'daily', mandateStartsAt: utc(2026, 1, 1) });
    const period = occurrenceDueAt(f, 0);
    const nextPeriod = occurrenceDueAt(f, 1);
    for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_CYCLE; attempt++) {
      const slot = retryDueAt(f, 0, attempt);
      expect(slot.getTime()).toBeGreaterThan(period.getTime());
      // A retry that landed in the next period would be indistinguishable from
      // that period's own charge.
      expect(slot.getTime()).toBeLessThan(nextPeriod.getTime());
    }
  });

  it('waits for the retry slot rather than hammering every pass', () => {
    const f = frame({ cadence: 'daily' });
    const plan = planChargeCycle({ frame: f, last: rejected(0, 1), now: utc(2026, 1, 1, 1) });
    expect(plan.kind).toBe('idle');
    expect(plan.nextRunAt.toISOString()).toBe(retryDueAt(f, 0, 1).toISOString());
  });
});

// ── 4. THE MANDATE IS THE CEILING ───────────────────────────────────────────

describe('never charge more than the mandate authorises', () => {
  it('a null ceiling means the amount IS the bound — not unbounded', () => {
    expect(mandateChargeCeiling({ amount: amt('10'), ceiling: null })).toBe(amt('10'));
    expect(mandateChargeCeiling({ amount: amt('10'), ceiling: amt('25') })).toBe(amt('25'));
  });

  it('REFUSES a charge above the ceiling by code', () => {
    const mandate = { amount: amt('10'), ceiling: amt('25') };
    expect(() => assertWithinMandateCeiling(mandate, amt('25'))).not.toThrow();
    try {
      assertWithinMandateCeiling(mandate, amt('25.000000000000000001'));
      throw new Error('should have refused');
    } catch (err) {
      expect(err).toBeInstanceOf(PayError);
      expect((err as PayError).code).toBe('pay.subscription_exceeds_mandate');
    }
  });

  it('REFUSES a charge above a ceiling-less mandate amount', () => {
    try {
      assertWithinMandateCeiling({ amount: amt('10'), ceiling: null }, amt('11'));
      throw new Error('should have refused');
    } catch (err) {
      expect((err as PayError).code).toBe('pay.subscription_exceeds_mandate');
    }
  });

  it('refuses a zero or negative charge — that is not a charge', () => {
    expect(() => assertWithinMandateCeiling({ amount: amt('10'), ceiling: null }, amt('0'))).toThrow(/not a charge/);
    expect(() => assertWithinMandateCeiling({ amount: amt('10'), ceiling: null }, amt('0'))).toThrow(PayError);
  });

  it('the WINDOW is consent too — refuses before startsAt and at/after endsAt', () => {
    const mandate = { startsAt: utc(2026, 1, 1), endsAt: utc(2026, 7, 1) };
    expect(() => assertWithinMandateWindow(mandate, utc(2026, 1, 1))).not.toThrow();
    expect(() => assertWithinMandateWindow(mandate, utc(2026, 6, 30))).not.toThrow();
    expect(() => assertWithinMandateWindow(mandate, utc(2025, 12, 31))).toThrow(/pay\.subscription_exceeds_mandate|before/);
    // endsAt is EXCLUSIVE — a charge at the instant authorisation ended is not authorised.
    expect(() => assertWithinMandateWindow(mandate, utc(2026, 7, 1))).toThrow(PayError);
  });

  it('an open-ended mandate has no time ceiling', () => {
    expect(() => assertWithinMandateWindow({ startsAt: utc(2026, 1, 1), endsAt: null }, utc(2099, 1, 1))).not.toThrow();
  });

  /**
   * `Invalid Date#getTime()` is NaN, and every NaN comparison is false. A blank
   * bound used to skip both guards and count as inside the consent window.
   */
  it('refuses an Invalid Date bound — NaN is not inside the window', () => {
    const startsAt = utc(2026, 1, 1);
    const endsAt = utc(2026, 7, 1);
    const at = utc(2026, 3, 1);
    const invalid = new Date(NaN);

    for (const call of [
      () => assertWithinMandateWindow({ startsAt: invalid, endsAt }, at),
      () => assertWithinMandateWindow({ startsAt, endsAt: invalid }, at),
      () => assertWithinMandateWindow({ startsAt, endsAt }, invalid),
    ]) {
      try {
        call();
        throw new Error('should have refused');
      } catch (err) {
        expect(err).toBeInstanceOf(PayError);
        expect((err as PayError).code).toBe('pay.subscription_exceeds_mandate');
      }
    }
    expect(() => assertWithinMandateWindow({ startsAt, endsAt }, at)).not.toThrow();
    expect(() => assertWithinMandateWindow({ startsAt, endsAt: null }, at)).not.toThrow();
  });
});

// ── 5. EVERY RATE IS OWNER-ONLY ─────────────────────────────────────────────

describe('an unset fee is refuse-closed, not a zero', () => {
  it('REFUSES when neither the merchant nor the platform published a rate', () => {
    try {
      resolveSubscriptionFeeBps({});
      throw new Error('should have refused');
    } catch (err) {
      expect(err).toBeInstanceOf(PayError);
      expect((err as PayError).code).toBe('pay.subscription_fee_unpublished');
    }
  });

  /**
   * The specific temptation. Zero is a REAL rate that means "this merchant pays
   * nothing", and it is not the same statement as "nobody has said".
   */
  it('does not treat an unset rate as zero', () => {
    expect(() => resolveSubscriptionFeeBps({})).toThrow(PayError);
    expect(() => resolveSubscriptionFeeBps({ defaultFeeBps: null })).toThrow(PayError);
    expect(resolveSubscriptionFeeBps({ merchantFeeBps: 0 })).toBe(0);
    expect(resolveSubscriptionFeeBps({ defaultFeeBps: 0 })).toBe(0);
  });

  it('prefers the merchant’s own published rate over the platform default', () => {
    expect(resolveSubscriptionFeeBps({ merchantFeeBps: 150, defaultFeeBps: 250 })).toBe(150);
    expect(resolveSubscriptionFeeBps({ defaultFeeBps: 250 })).toBe(250);
  });

  it('refuses a nonsense rate rather than clamping it', () => {
    expect(() => resolveSubscriptionFeeBps({ merchantFeeBps: 10_001 })).toThrow(PayError);
    expect(() => resolveSubscriptionFeeBps({ merchantFeeBps: -1 })).toThrow(PayError);
    expect(() => resolveSubscriptionFeeBps({ merchantFeeBps: 12.5 })).toThrow(PayError);
  });
});

// ── 6. WHERE THIS DIFFERS FROM THE TWAP RULING, AND WHY ─────────────────────

describe('re-spacing stops at the mandate window', () => {
  const bounded = frame({ mandateStartsAt: utc(2026, 1, 1), mandateEndsAt: utc(2026, 7, 1) });

  it('counts the periods the window authorises', () => {
    // Jan..Jun starts inside [Jan 1, Jul 1) → occurrences 0..5.
    expect(lastAuthorisedOccurrence(bounded)).toBe(5);
    expect(lastAuthorisedOccurrence(frame())).toBeNull();
  });

  it('projects the new end so a resume can report it', () => {
    const p = projectReAnchor(bounded, { at: utc(2026, 3, 1), nextOccurrence: 2 });
    expect(p.remaining).toBe(4);
    expect(p.projectedEnd?.toISOString()).toBe(utc(2026, 7, 1).toISOString());
    expect(p.fits).toBe(true);
  });

  it('does NOT fit when re-spacing would run past endsAt', () => {
    // Two months lost: the four periods still owed cannot end by 1 July.
    const p = projectReAnchor(bounded, { at: utc(2026, 5, 1), nextOccurrence: 2 });
    expect(p.fits).toBe(false);
    expect(p.projectedEnd!.getTime()).toBeGreaterThan(utc(2026, 7, 1).getTime());
  });

  /**
   * NOT compressed (the TWAP defect) and NOT silently dropped (the "skip" the
   * ADR rejects). Blocked, named, and visible — the merchant re-consents with a
   * new mandate.
   */
  it('blocks with window_exhausted instead of compressing or dropping', () => {
    const plan = planChargeCycle({ frame: bounded, last: settled(1), now: utc(2026, 5, 1) });
    expect(plan).toMatchObject({ kind: 'blocked', reason: 'window_exhausted' });
  });

  it('an open-ended mandate re-spaces freely', () => {
    const p = projectReAnchor(frame(), { at: utc(2099, 1, 1), nextOccurrence: 4 });
    expect(p.fits).toBe(true);
    expect(p.projectedEnd).toBeNull();
  });

  it('completes once the window is spent, rather than charging past it', () => {
    const plan = planChargeCycle({ frame: bounded, last: settled(5), now: utc(2026, 8, 1) });
    expect(plan.kind).toBe('completed');
  });
});

// ── 7. THE FRAME'S ARITHMETIC ───────────────────────────────────────────────

describe('occurrence due times in a moved frame', () => {
  it('numbering continues across a re-anchor — which is what keeps keys stable', () => {
    const moved = frame({ anchorAt: utc(2026, 5, 10), anchorOccurrence: 3 });
    expect(occurrenceDueAt(moved, 3).toISOString()).toBe(utc(2026, 5, 10).toISOString());
    expect(occurrenceDueAt(moved, 4).toISOString()).toBe(utc(2026, 6, 10).toISOString());
    // The key for period 3 is the key for period 3, before and after the move.
    expect(chargeIdempotencyKey({ subscriptionId: SUB, occurrence: 3 })).toBe(`pay.subscription:${SUB}:3`);
  });

  it('answers history from the mandate frame, not the moved one', () => {
    const moved = frame({ anchorAt: utc(2026, 5, 10), anchorOccurrence: 3 });
    // Period 0 happened long before the anchor moved; its date is not re-written.
    expect(occurrenceDueAt(moved, 0).toISOString()).toBe(utc(2026, 1, 1).toISOString());
  });

  it('a null anchor means the mandate’s own start', () => {
    expect(occurrenceDueAt(frame(), 0).toISOString()).toBe(utc(2026, 1, 1).toISOString());
    expect(occurrenceDueAt(frame(), 2).toISOString()).toBe(utc(2026, 3, 1).toISOString());
  });

  it('the catch-up bound it replaces is still what it was', () => {
    // Documented contrast, not a dependency: 12 was a smaller burst, not a fix.
    expect(MAX_CATCH_UP_PER_PASS).toBe(12);
    expect(MAX_ATTEMPTS_PER_CYCLE).toBeLessThan(MAX_CATCH_UP_PER_PASS);
  });
});
