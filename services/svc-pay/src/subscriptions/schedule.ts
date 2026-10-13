/**
 * SUBSCRIPTION SCHEDULE ARITHMETIC — pure, no I/O, no clock of its own.
 *
 * Transplanted from `services/svc-bank/src/transfers/schedule.ts` for pay
 * subscriptions (invoice-and-watch / mandate-backed recurring). Same laws:
 * occurrence N is defined by `(startsAt, cadence, N)` so the business key
 * `pay.subscription:<subId>:<occurrence>` is stable across workers, retries,
 * and catch-up after outage.
 *
 * Nothing here moves money. Crypto path never pulls (protocol forbids
 * allowances). This module only answers "which occurrence is due."
 *
 * Nothing here reads `Date.now()`. `now` is always passed in.
 */

export const CADENCES = ['daily', 'weekly', 'monthly'] as const;
export type Cadence = (typeof CADENCES)[number];

/**
 * How far a catch-up pass may go in one run.
 *
 * A schedule whose `startsAt` is years in the past would otherwise fire hundreds
 * of transfers the moment it is first considered. Bounding the pass means the
 * backlog drains over several runs, visibly, instead of arriving as one
 * unexplained wall of movements on a user's statement.
 */
export const MAX_CATCH_UP_PER_PASS = 12;

/**
 * When occurrence `n` is due.
 *
 * Always computed FROM `startsAt`, never by repeatedly advancing the previous
 * occurrence. For monthly schedules that difference is load-bearing: a standing
 * order anchored on the 31st advanced month-by-month drifts to the 28th and
 * stays there forever (31 Jan → 28 Feb → 28 Mar). Computed from the anchor, it
 * clamps only in the short months and returns to the 31st afterwards, which is
 * what "the 31st of every month" means to the person who set it.
 */
export function occurrenceStart(startsAt: Date, cadence: Cadence, occurrence: number): Date {
  if (!Number.isInteger(occurrence) || occurrence < 0) {
    throw new RangeError(`Occurrence must be a non-negative integer, got ${occurrence}`);
  }

  const DAY_MS = 24 * 60 * 60 * 1000;

  switch (cadence) {
    case 'daily':
      return new Date(startsAt.getTime() + occurrence * DAY_MS);
    case 'weekly':
      return new Date(startsAt.getTime() + occurrence * 7 * DAY_MS);
    case 'monthly': {
      const year = startsAt.getUTCFullYear();
      const month = startsAt.getUTCMonth() + occurrence;
      const day = startsAt.getUTCDate();
      const targetYear = year + Math.floor(month / 12);
      const targetMonth = ((month % 12) + 12) % 12;
      // Days in the target month, so the 31st lands on the 30th/28th/29th
      // rather than rolling into the following month.
      const daysInMonth = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
      return new Date(
        Date.UTC(
          targetYear,
          targetMonth,
          Math.min(day, daysInMonth),
          startsAt.getUTCHours(),
          startsAt.getUTCMinutes(),
          startsAt.getUTCSeconds(),
          startsAt.getUTCMilliseconds(),
        ),
      );
    }
  }
}

/**
 * The highest occurrence index that is due at `now`, or `null` if the schedule
 * has not started yet.
 *
 * Daily and weekly are arithmetic. Monthly is a bounded search from an estimate,
 * because clamping makes it non-uniform — a closed-form inverse would be wrong
 * in exactly the short months where a bug costs a user their rent transfer.
 */
export function dueOccurrence(startsAt: Date, cadence: Cadence, now: Date): number | null {
  if (now.getTime() < startsAt.getTime()) return null;

  const DAY_MS = 24 * 60 * 60 * 1000;
  const elapsed = now.getTime() - startsAt.getTime();

  if (cadence === 'daily') return Math.floor(elapsed / DAY_MS);
  if (cadence === 'weekly') return Math.floor(elapsed / (7 * DAY_MS));

  // Monthly: estimate, then walk to the exact answer. The estimate is never
  // more than a month out, so this terminates in a handful of steps.
  let n = (now.getUTCFullYear() - startsAt.getUTCFullYear()) * 12 + (now.getUTCMonth() - startsAt.getUTCMonth());
  if (n < 0) n = 0;
  while (n > 0 && occurrenceStart(startsAt, cadence, n).getTime() > now.getTime()) n--;
  while (occurrenceStart(startsAt, cadence, n + 1).getTime() <= now.getTime()) n++;
  return n;
}

/**
 * The last occurrence index still inside `[startsAt, endsAt)`, or null.
 *
 * Null covers two different windows. An omitted `endsAt` is open: there is no
 * last occurrence because the schedule does not end. An `endsAt` at or before
 * `startsAt` is empty: no occurrence sits inside it. Callers that treat every
 * null as unbounded must check that `endsAt` was omitted first.
 */
export function lastOccurrenceBefore(startsAt: Date, cadence: Cadence, endsAt: Date | null): number | null {
  if (!endsAt) return null;
  if (endsAt.getTime() <= startsAt.getTime()) return null;
  const n = dueOccurrence(startsAt, cadence, new Date(endsAt.getTime() - 1));
  return n;
}

export interface DuePlan {
  /** Occurrences to fire this pass, in order. Empty when nothing is due. */
  readonly occurrences: readonly number[];
  /** When the runner should look at this schedule again. */
  readonly nextRunAt: Date;
  /** True when the schedule's window has closed and it will never fire again. */
  readonly completed: boolean;
}

/**
 * What this pass should do with one schedule.
 *
 * `lastFired` comes from subscription executions — the record of what has
 * ALREADY happened — and never from a counter on the schedule row. That is
 * deliberate: a counter can be double-incremented by a retry, silently skipping
 * a charge, and nothing would ever notice. The executions table cannot skip,
 * because firing an occurrence and recording it are the same write.
 */
export function planDue(input: {
  startsAt: Date;
  cadence: Cadence;
  endsAt: Date | null;
  /** Highest occurrence already recorded (settled OR rejected), or null if none. */
  lastFired: number | null;
  now: Date;
  maxCatchUp?: number;
}): DuePlan {
  const { startsAt, cadence, endsAt, lastFired, now } = input;
  const maxCatchUp = input.maxCatchUp ?? MAX_CATCH_UP_PER_PASS;

  // `lastOccurrenceBefore` returns null for an omitted `endsAt` and for an
  // `endsAt` at or before `startsAt`. Only the omitted end is an open window.
  // The inverted pair contains no occurrence; reading it as unbounded would
  // keep scheduling charges with no end. The end instant is the caller's —
  // this does not invent a period to stand in for the missing window.
  if (endsAt !== null && endsAt.getTime() <= startsAt.getTime()) {
    return { occurrences: [], nextRunAt: new Date(endsAt.getTime()), completed: true };
  }

  const windowEnd = lastOccurrenceBefore(startsAt, cadence, endsAt);
  const due = dueOccurrence(startsAt, cadence, now);

  if (due === null) {
    // Not started. Look again when occurrence 0 lands.
    return { occurrences: [], nextRunAt: occurrenceStart(startsAt, cadence, 0), completed: false };
  }

  const ceiling = windowEnd === null ? due : Math.min(due, windowEnd);
  const from = lastFired === null ? 0 : lastFired + 1;

  if (from > ceiling) {
    const completed = windowEnd !== null && from > windowEnd;
    return {
      occurrences: [],
      nextRunAt: occurrenceStart(startsAt, cadence, completed ? ceiling : from),
      completed,
    };
  }

  const upTo = Math.min(ceiling, from + maxCatchUp - 1);
  const occurrences: number[] = [];
  for (let n = from; n <= upTo; n++) occurrences.push(n);

  const nextIndex = upTo + 1;
  const completed = windowEnd !== null && nextIndex > windowEnd;

  return {
    occurrences,
    nextRunAt: occurrenceStart(startsAt, cadence, completed ? upTo : nextIndex),
    completed,
  };
}
