/**
 * SCHEDULE ARITHMETIC — pure, no I/O, no clock of its own.
 *
 * These functions decide which firing of a standing order is due, and they are
 * the reason the idempotency key `bank.transfer.sched:<scheduleId>:<occurrence>` is a
 * BUSINESS key rather than a timestamp. Occurrence N is defined entirely by
 * `(startsAt, cadence, N)`, so two workers, a retry, and a catch-up run after an
 * outage all compute the same N for the same intended transfer — and the ledger
 * collapses them into one movement.
 *
 * Nothing here reads `Date.now()`. `now` is always passed in, so every branch is
 * testable without waiting and without a clock mock.
 */

export const CADENCES = ['daily', 'weekly', 'monthly'] as const;
export type Cadence = (typeof CADENCES)[number];
/** Standing orders also take `once` (BK-xfer-10): a single occurrence, 0. Auto-invest DCA keeps `Cadence`. */
export const SCHEDULE_CADENCES = ['once', ...CADENCES] as const;
export type ScheduleCadence = (typeof SCHEDULE_CADENCES)[number];

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
export function occurrenceStart(startsAt: Date, cadence: ScheduleCadence, occurrence: number): Date {
  if (!Number.isInteger(occurrence) || occurrence < 0) {
    throw new RangeError(`Occurrence must be a non-negative integer, got ${occurrence}`);
  }

  const DAY_MS = 24 * 60 * 60 * 1000;

  switch (cadence) {
    case 'once':
      if (occurrence !== 0) throw new RangeError(`A once schedule has only occurrence 0, got ${occurrence}`);
      return startsAt;
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
export function dueOccurrence(startsAt: Date, cadence: ScheduleCadence, now: Date): number | null {
  if (now.getTime() < startsAt.getTime()) return null;

  const DAY_MS = 24 * 60 * 60 * 1000;
  const elapsed = now.getTime() - startsAt.getTime();

  if (cadence === 'once') return 0;
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

/** The last occurrence index still inside the schedule's window, or null if none. */
export function lastOccurrenceBefore(startsAt: Date, cadence: ScheduleCadence, endsAt: Date | null): number | null {
  // A once schedule's window is occurrence 0, whatever the end date says (an end at or before the start still empties it).
  if (cadence === 'once') return endsAt && endsAt.getTime() <= startsAt.getTime() ? -1 : 0;
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
 * `lastFired` comes from `bank.transfer_executions` — the record of what has
 * ALREADY happened — and never from a counter on the schedule row. That is
 * deliberate: a counter can be double-incremented by a retry, silently skipping
 * a user's transfer, and nothing would ever notice. The executions table cannot
 * skip, because firing an occurrence and recording it are the same write.
 */
export function planDue(input: {
  startsAt: Date;
  cadence: ScheduleCadence;
  endsAt: Date | null;
  /** Highest occurrence already recorded (settled OR rejected), or null if none. */
  lastFired: number | null;
  now: Date;
  maxCatchUp?: number;
}): DuePlan {
  const { startsAt, cadence, endsAt, lastFired, now } = input;
  const maxCatchUp = input.maxCatchUp ?? MAX_CATCH_UP_PER_PASS;

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
