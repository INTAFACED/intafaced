/**
 * THE RECURRING CHARGE CYCLE — schedule, due, attempt, outcome. Pure law.
 *
 * No I/O, no clock of its own, no ledger. `now` is always passed in. Everything
 * here is a decision this repository has already been bitten by once, written
 * down so the next reviewer can check the decision instead of re-deriving it.
 *
 * ── WHAT THE ENGINE MAY AND MAY NOT DO (established before writing) ─────────
 *
 * **Crypto does not pull, and that is an owner posture, not an unfinished half.**
 * `services/svc-protocol/src/session/spec.ts` refuses to build any session that
 * can call the ERC-20 `approve` selector — its own words: *"an allowance is a
 * delayed transfer."* A recurring on-chain pull IS an allowance. So the crypto
 * path is invoice-and-watch: the cycle opens an invoice, the customer pays it,
 * and `payment.captured` settles the period. #1367's "(no auto-pull)" is that
 * ruling, not a TODO.
 *
 * **Card does not pull either, because the port cannot.** `rails/rail-adapter.ts`
 * declares a `mandate` capability with `createMandate` / `revokeMandate` and
 * **no charge-against-mandate operation at all**, and no registered adapter
 * declares `mandate`. Wiring card auto-pull is a rail-port widening plus a
 * conformance-kit entry, not a subscription change. It stays refused by name
 * (`pay.mandate_rail_absent`) and this module keeps that refusal a first-class,
 * tested outcome rather than a silent skip.
 *
 * So: this module owns the CYCLE — when a period falls due, whether a late one
 * compresses, what a failure does to the next period, and what the charge is
 * allowed to be. It does not own the pull, because there is no legitimate pull
 * to own.
 *
 * ── THE FOUR RULINGS THIS ENCODES ───────────────────────────────────────────
 *
 * **1. Idempotency per business event, never per attempt.** The business event
 * is the PERIOD. `pay.subscription:<subscriptionId>:<occurrence>` — and
 * `occurrence` is an integer derived from the schedule, so the key is
 * byte-identical on the third retry at a different second of a different day.
 * `close:${positionId}` survived here; `close:${id}:${randomUUID()}` drained a
 * pot.
 *
 * **2. The interval is the promise.**
 * `adr/2026-08-08-twap-overdue-slice-disposition.md` (Accepted) rules exactly
 * this shape: overdue units *extend* the schedule, they are neither compressed
 * nor forfeited, and due times are re-derived from the resume instant rather
 * than from creation. A subscription that catches up by charging four months at
 * once is that defect with a bigger blast radius, and it needs no user action —
 * a cron host down for a while is enough. So: **at most one charge per
 * subscription per pass**, and a late period re-anchors the frame.
 *
 * **3. A missed cycle is not a skipped cycle.**
 * `adr/2026-08-05-futures-risk-and-mark-law.md` §Funding: *"A period that cannot
 * be settled blocks the next one rather than being silently skipped, because
 * compounding a gap changes what every subsequent position paid."* Held here:
 * an unsettled period blocks the next one, is retried under the same key up to
 * a bound, and then STALLS the subscription with a named reason. It never rolls
 * forward, and it is never recorded as a zero-amount period — `amount > 0` is a
 * database CHECK, so a zero-amount cycle cannot be written at all.
 *
 * **4. The mandate is the ceiling — in money and in time.** Checked at the
 * moment of the charge, not at the moment of the plan, because a mandate can be
 * cancelled or replaced between a period being claimed and that period being
 * retried.
 *
 * ── WHERE THIS DELIBERATELY DIFFERS FROM THE TWAP RULING ────────────────────
 *
 * The TWAP ADR says overdue units extend the schedule, full stop. A subscription
 * cannot extend past its mandate's `endsAt`, because the window is part of what
 * the customer authorised — charging beyond it is charging without consent, and
 * "the mandate is the ceiling" is the harder rule of the two.
 *
 * Silently dropping the tail is also refused (the ADR rejects "skip" for good
 * reasons that apply here too). So the third option is taken, and it is the one
 * the ADR itself takes for a resume past 2× duration: **refuse, name it, and let
 * the merchant re-consent.** A resume that will not fit inside the mandate
 * window returns `pay.subscription_resume_exceeds_mandate` with the projected
 * end; an outage that will not fit stalls with a reason, because there is no
 * caller to refuse to. Unbounded mandates (`endsAt === null`) re-space freely.
 */

import type { Amount } from '@intafaced/ledger-client';
import { formatAmount } from '@intafaced/ledger-client';
import { PayError } from '../payment-service.js';
import { dueOccurrence, lastOccurrenceBefore, occurrenceStart, type Cadence } from './schedule.js';
import { MAX_FEE_BPS } from '../fee-bps-bound.js';

/**
 * How many times one period may be attempted before the subscription stalls.
 *
 * Same class of number as `MAX_CATCH_UP_PER_PASS` — an operational bound, not a
 * rate and not a fee, so it is not owner-published. It is deliberately small:
 * every attempt on an unpaid period is a second invoice in the customer's
 * inbox, and the honest end of a failing subscription is a stalled record an
 * operator can see, not an indefinite retry loop nobody reads.
 */
export const MAX_ATTEMPTS_PER_CYCLE = 3;

/** Why a subscription stopped advancing. Each word is a different fact. */
export const STALL_REASONS = [
  'operator_pause',
  'runner_outage',
  'arrears',
  'fee_unpublished',
  'window_exhausted',
  'due_pass_fault',
] as const;
export type StallReason = (typeof STALL_REASONS)[number];

/** Statuses an execution row can carry (0010's enum). */
export type CycleStatus = 'pending' | 'invoiced' | 'settled' | 'rejected' | 'skipped';

/**
 * THE BUSINESS IDEMPOTENCY KEY.
 *
 * `(subscriptionId, occurrence)` and nothing else. No clock, no random source,
 * no attempt counter — those are the three things that turn a retry into a
 * second charge. `occurrence` is the period, and the period is the business
 * event.
 */
export function chargeIdempotencyKey(input: { subscriptionId: string; occurrence: number }): string {
  if (!Number.isInteger(input.occurrence) || input.occurrence < 0) {
    throw new PayError(`Occurrence must be a non-negative integer, got ${input.occurrence}`, 'pay.subscription_invalid');
  }
  if (!input.subscriptionId.trim()) {
    throw new PayError('Subscription id is required to key a charge', 'pay.subscription_invalid');
  }
  return `pay.subscription:${input.subscriptionId}:${input.occurrence}`;
}

/**
 * Shapes that mean "this key was derived from an attempt, not from a period".
 *
 * Kept as data rather than prose so a test can assert against it. A key
 * containing a fresh UUID or an ISO timestamp is unique per attempt, which is
 * the opposite of what an idempotency key is for.
 */
const PER_ATTEMPT_KEY_SHAPES: ReadonlyArray<{ readonly name: string; readonly pattern: RegExp }> = [
  { name: 'a UUID (one per attempt, not one per period)', pattern: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i },
  { name: 'an ISO-8601 timestamp (a clock reading)', pattern: /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/ },
  { name: 'an epoch-millisecond clock reading', pattern: /\b1[6-9]\d{11}\b/ },
];

/**
 * Refuses a key that cannot survive a retry.
 *
 * A subscription id is a UUID, so the guard is applied to the key with the
 * subscription id removed — otherwise every correct key would look wrong. What
 * is being refused is an EXTRA per-attempt token: `…:<occurrence>:<uuid>`.
 */
export function assertKeyedByPeriod(key: string, subscriptionId: string): void {
  const withoutSubject = key.split(subscriptionId).join('<sub>');
  for (const shape of PER_ATTEMPT_KEY_SHAPES) {
    if (shape.pattern.test(withoutSubject)) {
      throw new PayError(
        `Charge idempotency key "${key}" contains ${shape.name}. ` +
          `A subscription period is the business event — key it from (subscription, occurrence) or a retry charges twice.`,
        'pay.subscription_invalid',
      );
    }
  }
}

// ── THE MANDATE IS THE CEILING ───────────────────────────────────────────────

/**
 * The most a single charge on this mandate may be.
 *
 * `ceiling === null` means "the authorised amount is the only bound" (0010's
 * words). It does not mean unbounded.
 */
export function mandateChargeCeiling(mandate: { amount: Amount; ceiling: Amount | null }): Amount {
  return mandate.ceiling === null ? mandate.amount : mandate.ceiling;
}

/**
 * Refuses a charge above what the mandate authorises.
 *
 * Called at the moment of the CHARGE with the amount recorded on the period,
 * not at the moment of the plan with the amount just read from the mandate — the
 * second is true by construction and would be a guard that can never fire. The
 * reachable case is a retry: a period claimed under one mandate reading and
 * attempted again after the mandate's terms were lowered or replaced.
 */
export function assertWithinMandateCeiling(mandate: { amount: Amount; ceiling: Amount | null }, charge: Amount): void {
  if (charge <= 0n) {
    throw new PayError(`A charge of ${formatAmount(charge)} is not a charge`, 'pay.invalid_amount');
  }
  const ceiling = mandateChargeCeiling(mandate);
  if (charge > ceiling) {
    throw new PayError(
      `Charge ${formatAmount(charge)} exceeds the ${formatAmount(ceiling)} this mandate authorises`,
      'pay.subscription_exceeds_mandate',
    );
  }
}

/**
 * Refuses a charge outside the mandate's authorised WINDOW.
 *
 * The window is consent too. `startsAt` is inclusive, `endsAt` exclusive, which
 * matches `lastOccurrenceBefore`. `endsAt === null` is an open end, not a blank
 * bound.
 *
 * An `Invalid Date` makes `getTime()` NaN, and every NaN comparison is false, so
 * a missing or unparsable bound would skip both guards and be treated as inside
 * the window. A blank bound refuses the charge. The message is built only after
 * the instant is known to be real — `toISOString` on an Invalid Date throws.
 */
export function assertWithinMandateWindow(mandate: { startsAt: Date; endsAt: Date | null }, at: Date): void {
  const startMs = mandate.startsAt.getTime();
  const atMs = at.getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(atMs)) {
    throw new PayError('Mandate window is not a date — refusing the charge', 'pay.subscription_exceeds_mandate');
  }
  if (atMs < startMs) {
    throw new PayError(`Mandate does not authorise a charge before ${mandate.startsAt.toISOString()}`, 'pay.subscription_exceeds_mandate');
  }
  if (mandate.endsAt !== null) {
    const endMs = mandate.endsAt.getTime();
    if (!Number.isFinite(endMs)) {
      throw new PayError('Mandate window is not a date — refusing the charge', 'pay.subscription_exceeds_mandate');
    }
    if (atMs >= endMs) {
      throw new PayError(`Mandate authorisation ended at ${mandate.endsAt.toISOString()}`, 'pay.subscription_exceeds_mandate');
    }
  }
}

// ── EVERY RATE IS OWNER-ONLY ─────────────────────────────────────────────────

/**
 * The fee rate that will apply to this subscription's charges, or a refusal.
 *
 * Standing ruling, and `services/svc-trade/src/copy/fee-share-law.ts` is the
 * reference implementation: *a surface whose rate is unset is refuse-closed and
 * says so — it does not fall back to a source seed, a zero, or a "sensible
 * default."* svc-pay already holds this line at settlement (`prepareSettlement`
 * refuses at an unknown price rather than settling a merchant at zero, "revenue
 * that is not merely lost but invisible").
 *
 * The cycle has to hold it EARLIER than settlement does. An invoice opened at an
 * unknown price is a customer charged for a period whose fee nobody can compute
 * — the charge is real and the refusal arrives weeks later, at settlement, with
 * the money already collected. So the period is refused before it is claimed:
 * no execution row, no attempt consumed, the period still owed, and the
 * subscription stalled with `fee_unpublished` so an operator can see why.
 */
export function resolveSubscriptionFeeBps(input: { merchantFeeBps?: number | null; defaultFeeBps?: number | null }): number {
  const bps = input.merchantFeeBps ?? input.defaultFeeBps;
  if (bps == null) {
    throw new PayError(
      'This merchant has no published fee rate and no default is configured — refusing to open a subscription charge at an unknown price',
      'pay.subscription_fee_unpublished',
    );
  }
  if (!Number.isInteger(bps) || bps < 0 || bps > MAX_FEE_BPS) {
    throw new PayError(
      `Subscription fee must be an integer between 0 and ${MAX_FEE_BPS} bps, got ${bps}`,
      'pay.subscription_fee_unpublished',
    );
  }
  return bps;
}

// ── THE CYCLE PLANNER ────────────────────────────────────────────────────────

/** What the last recorded period of a subscription looks like to the planner. */
export interface LastCycle {
  readonly occurrence: number;
  readonly status: CycleStatus;
  readonly attemptCount: number;
  readonly exhausted: boolean;
  /** When the last attempt on this period ran, for retry spacing. */
  readonly lastAttemptAt: Date | null;
}

export interface CycleFrame {
  readonly cadence: Cadence;
  readonly mandateStartsAt: Date;
  readonly mandateEndsAt: Date | null;
  /** Current schedule anchor. `null` means "the mandate's own startsAt". */
  readonly anchorAt: Date | null;
  readonly anchorOccurrence: number;
}

export type CycleDisposition =
  /** Nothing due. `nextRunAt` is when to look again. */
  | { readonly kind: 'idle'; readonly nextRunAt: Date }
  /** Charge this period for the first time. */
  | {
      readonly kind: 'charge';
      readonly occurrence: number;
      readonly periodStart: Date;
      readonly nextRunAt: Date;
      /** Non-null when the frame must move — a late period must not compress. */
      readonly reAnchor: { readonly at: Date; readonly occurrence: number } | null;
      /** Whole intervals this period is late by. `>= 1` means the runner stalled. */
      readonly lateIntervals: number;
    }
  /** Re-attempt this period under the SAME business key. */
  | {
      readonly kind: 'retry';
      readonly occurrence: number;
      readonly periodStart: Date;
      readonly attempt: number;
      readonly nextRunAt: Date;
    }
  /** An unsettled period blocks the next. Nothing fires; the record explains why. */
  | {
      readonly kind: 'blocked';
      readonly occurrence: number;
      readonly reason: StallReason;
      readonly nextRunAt: Date;
    }
  /** The mandate window is spent. The subscription will never fire again. */
  | { readonly kind: 'completed'; readonly nextRunAt: Date };

/** Milliseconds in one cadence interval, measured on the frame it applies to. */
function intervalMsAt(anchor: Date, cadence: Cadence, occurrence: number): number {
  return occurrenceStart(anchor, cadence, occurrence + 1).getTime() - occurrenceStart(anchor, cadence, occurrence).getTime();
}

/** The effective anchor: an explicit one, or the mandate's own start. */
function effectiveAnchor(frame: CycleFrame): { at: Date; occurrence: number } {
  return frame.anchorAt === null
    ? { at: frame.mandateStartsAt, occurrence: 0 }
    : { at: frame.anchorAt, occurrence: frame.anchorOccurrence };
}

/** When occurrence `n` is due in this frame. */
export function occurrenceDueAt(frame: CycleFrame, occurrence: number): Date {
  const anchor = effectiveAnchor(frame);
  const offset = occurrence - anchor.occurrence;
  if (offset < 0) {
    // A period BEFORE the anchor: only reachable for already-recorded history,
    // which the planner never re-times. Answer honestly from the mandate frame.
    return occurrenceStart(frame.mandateStartsAt, frame.cadence, occurrence);
  }
  return occurrenceStart(anchor.at, frame.cadence, offset);
}

/**
 * The highest occurrence the mandate's WINDOW authorises, or null for unbounded.
 *
 * Measured on the MANDATE frame, not the anchor frame: the window is a property
 * of the authorisation and re-anchoring does not buy more periods. That is the
 * whole reason a resume can be refused.
 */
export function lastAuthorisedOccurrence(frame: CycleFrame): number | null {
  return lastOccurrenceBefore(frame.mandateStartsAt, frame.cadence, frame.mandateEndsAt);
}

/**
 * Whether the periods still owed fit inside the mandate window if the schedule
 * is re-anchored at `at` — and where re-spacing would land if not.
 *
 * This is the projection a resume reports and, when it does not fit, refuses
 * with. The TWAP ADR requires a resume to report its new projected end rather
 * than let the caller assume the original one.
 */
export function projectReAnchor(
  frame: CycleFrame,
  input: { at: Date; nextOccurrence: number },
): { fits: boolean; remaining: number; projectedEnd: Date | null; windowEnd: Date | null } {
  const authorised = lastAuthorisedOccurrence(frame);
  if (authorised === null) {
    return { fits: true, remaining: Number.POSITIVE_INFINITY, projectedEnd: null, windowEnd: null };
  }
  const remaining = authorised - input.nextOccurrence + 1;
  if (remaining <= 0) {
    return { fits: true, remaining: 0, projectedEnd: null, windowEnd: frame.mandateEndsAt };
  }
  // Last re-spaced period starts here; the period it opens closes one interval later.
  const lastStart = occurrenceStart(input.at, frame.cadence, remaining - 1);
  const projectedEnd = new Date(lastStart.getTime() + intervalMsAt(input.at, frame.cadence, remaining - 1));
  const fits = frame.mandateEndsAt === null || projectedEnd.getTime() <= frame.mandateEndsAt.getTime();
  return { fits, remaining, projectedEnd, windowEnd: frame.mandateEndsAt };
}

/**
 * When a failed period may be attempted again.
 *
 * Derived from the mandate's own cadence rather than from an invented backoff
 * constant — the TWAP ADR's reasoning for using a ratio: a number derived from
 * what the caller stated adds no parameter awaiting an owner ruling. Attempts
 * are spread across the period they belong to, so retrying never crosses into
 * the next period and never becomes a second charge in the same breath.
 */
export function retryDueAt(frame: CycleFrame, occurrence: number, attemptsSoFar: number): Date {
  const periodStart = occurrenceDueAt(frame, occurrence);
  const anchor = effectiveAnchor(frame);
  const interval = intervalMsAt(anchor.at, frame.cadence, Math.max(0, occurrence - anchor.occurrence));
  const slot = Math.floor(interval / (MAX_ATTEMPTS_PER_CYCLE + 1));
  return new Date(periodStart.getTime() + attemptsSoFar * slot);
}

/**
 * WHAT THIS PASS SHOULD DO WITH ONE SUBSCRIPTION.
 *
 * Returns at most ONE action. That is the interval-is-the-promise rule in its
 * strongest available form: there is no input to this function that produces two
 * charges, so no outage length and no pause length can compress a schedule.
 *
 * `last` is the highest recorded period and comes from the executions table —
 * the record of what already happened — never from a counter on the
 * subscription row, which a retry can double-increment.
 */
export function planChargeCycle(input: { frame: CycleFrame; last: LastCycle | null; now: Date }): CycleDisposition {
  const { frame, last, now } = input;
  const authorised = lastAuthorisedOccurrence(frame);

  // ── An unsettled period blocks the next one (futures ADR §Funding) ────────
  if (last !== null && last.status !== 'settled' && last.status !== 'skipped') {
    if (last.exhausted || last.attemptCount >= MAX_ATTEMPTS_PER_CYCLE) {
      // Every attempt spent. The period is NOT rolled forward and NOT recorded
      // as zero — it stands as a failed period and the subscription stalls.
      return { kind: 'blocked', occurrence: last.occurrence, reason: 'arrears', nextRunAt: now };
    }
    const due = retryDueAt(frame, last.occurrence, last.attemptCount);
    if (now.getTime() < due.getTime()) {
      return { kind: 'idle', nextRunAt: due };
    }
    return {
      kind: 'retry',
      occurrence: last.occurrence,
      periodStart: occurrenceDueAt(frame, last.occurrence),
      attempt: last.attemptCount + 1,
      nextRunAt: retryDueAt(frame, last.occurrence, last.attemptCount + 1),
    };
  }

  // ── Nothing owed is outstanding: the next period is the one after `last` ──
  const next = last === null ? 0 : last.occurrence + 1;

  if (authorised !== null && next > authorised) {
    return { kind: 'completed', nextRunAt: occurrenceDueAt(frame, authorised) };
  }

  const dueAt = occurrenceDueAt(frame, next);
  if (now.getTime() < dueAt.getTime()) {
    return { kind: 'idle', nextRunAt: dueAt };
  }

  // ── The period is due. How late, and does being late compress anything? ──
  const anchor = effectiveAnchor(frame);
  const interval = intervalMsAt(anchor.at, frame.cadence, Math.max(0, next - anchor.occurrence));
  const lateIntervals = Math.floor((now.getTime() - dueAt.getTime()) / interval);

  if (lateIntervals < 1) {
    // On time (inside its own interval). The frame does not move.
    return {
      kind: 'charge',
      occurrence: next,
      periodStart: dueAt,
      nextRunAt: occurrenceDueAt(frame, next + 1),
      reAnchor: null,
      lateIntervals,
    };
  }

  /*
   * A WHOLE INTERVAL OR MORE LATE. This is the TWAP case, arriving here by one
   * of two roads the ADR names: a resume, or "the tick host is simply down for
   * a while." Both must extend the schedule rather than fire back-to-back, and
   * the re-anchor is what does it: period `next` becomes due NOW, and every
   * period after it is spaced a full interval from there.
   */
  const projection = projectReAnchor(frame, { at: now, nextOccurrence: next });
  if (!projection.fits) {
    /*
     * Re-spacing would charge past the mandate's window, and the window is
     * consent. Neither compress (forbidden) nor drop the tail silently
     * (forbidden) — stop, and record why. There is no caller here to refuse to,
     * so the refusal is a stall an operator can see.
     */
    return { kind: 'blocked', occurrence: next, reason: 'window_exhausted', nextRunAt: now };
  }

  const reAnchored: CycleFrame = { ...frame, anchorAt: now, anchorOccurrence: next };
  return {
    kind: 'charge',
    occurrence: next,
    periodStart: now,
    nextRunAt: occurrenceDueAt(reAnchored, next + 1),
    reAnchor: { at: now, occurrence: next },
    lateIntervals,
  };
}

/**
 * How long an opened invoice may sit unpaid before the period is treated as
 * failed rather than pending forever.
 *
 * One full interval, derived from the mandate's cadence. An invoice still unpaid
 * when the next period would have fallen due is not "in flight" — it is a
 * period that did not settle, and the honest thing is to say so and let arrears
 * do its bounded work. Silence here is how a subscription reports itself as
 * healthy for a year while collecting nothing.
 */
export function invoiceExpiredAt(frame: CycleFrame, occurrence: number): Date {
  const anchor = effectiveAnchor(frame);
  const interval = intervalMsAt(anchor.at, frame.cadence, Math.max(0, occurrence - anchor.occurrence));
  return new Date(occurrenceDueAt(frame, occurrence).getTime() + interval);
}
