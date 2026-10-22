/**
 * Business hours, holidays and the out-of-hours reply (SP-sla-02).
 *
 * Pure time arithmetic plus the owner's settings book. Every answer is computed in the desk's own IANA zone from the
 * instant's own local date, so a daylight-saving day is as long as the zone says. Nothing is built in: with no zone or
 * no intervals the desk is unset, `isOpen` and `businessSeconds` refuse `support.hours_unset`, and no reply is sent.
 */
import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import {
  SUPPORT_WEEKDAYS,
  supportHoursMinutes,
  supportHoursSetKey,
  supportTimeZoneKnown,
  type SupportHours,
  type SupportHoursInterval,
  type SupportWeekday,
} from '@intafaced/contracts';

export class SupportHoursError extends Error {
  constructor(
    readonly code: 'support.hours_unset' | 'support.timezone_unknown' | 'support.hours_revision_stale',
    message = code,
  ) {
    super(message);
    this.name = 'SupportHoursError';
  }
}

export const blankHours = (): SupportHours => ({
  timeZone: null,
  intervals: [],
  holidays: [],
  outOfHoursReply: null,
  revision: 0,
  updatedAt: null,
});

type Local = { date: string; weekday: SupportWeekday; minute: number; offsetMs: number };

const WEEKDAY_BY_SHORT: Record<string, SupportWeekday> = {
  Mon: 'mon',
  Tue: 'tue',
  Wed: 'wed',
  Thu: 'thu',
  Fri: 'fri',
  Sat: 'sat',
  Sun: 'sun',
};
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone);
  if (!f) {
    if (!supportTimeZoneKnown(zone)) throw new SupportHoursError('support.timezone_unknown');
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    formatters.set(zone, f);
  }
  return f;
}

/** The wall clock in `zone` at `instant`, and the zone's offset from UTC there. */
export function localAt(instant: Date, zone: string): Local {
  const parts: Record<string, string> = {};
  for (const p of formatter(zone).formatToParts(instant)) parts[p.type] = p.value;
  const y = Number(parts.year);
  const mo = Number(parts.month);
  const d = Number(parts.day);
  const h = Number(parts.hour);
  const mi = Number(parts.minute);
  const s = Number(parts.second);
  const wallAsUtc = Date.UTC(y, mo - 1, d, h, mi, s);
  const whole = Math.floor(instant.getTime() / 1000) * 1000;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: WEEKDAY_BY_SHORT[parts.weekday!]!,
    minute: h * 60 + mi,
    offsetMs: wallAsUtc - whole,
  };
}

/** The instant a wall-clock minute on a local date happens in `zone`. A minute skipped by spring-forward lands just after the gap. */
export function instantOf(date: string, minute: number, zone: string): Date {
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
  const wall = Date.UTC(y, mo - 1, d, 0, minute);
  let guess = wall - localAt(new Date(wall), zone).offsetMs;
  // Two refinements settle every real zone, including the day the offset changes.
  for (let i = 0; i < 2; i += 1) guess = wall - localAt(new Date(guess), zone).offsetMs;
  return new Date(guess);
}

function requireSet(hours: SupportHours): { zone: string; intervals: readonly SupportHoursInterval[] } {
  if (hours.timeZone === null || hours.intervals.length === 0) throw new SupportHoursError('support.hours_unset');
  return { zone: hours.timeZone, intervals: hours.intervals };
}

const previousDay = (day: SupportWeekday): SupportWeekday => SUPPORT_WEEKDAYS[(SUPPORT_WEEKDAYS.indexOf(day) + 6) % 7]!;

/** Is the desk open at `instant`? A holiday is the local calendar date of the instant, closed all day. */
export function isOpen(hours: SupportHours, instant: Date): boolean {
  const { zone, intervals } = requireSet(hours);
  const local = localAt(instant, zone);
  if (hours.holidays.includes(local.date)) return false;
  for (const iv of intervals) {
    const open = supportHoursMinutes(iv.open);
    const close = supportHoursMinutes(iv.close);
    if (iv.day === local.weekday && local.minute >= open && (iv.closesNextDay || local.minute < close)) return true;
    if (iv.closesNextDay && iv.day === previousDay(local.weekday) && local.minute < close) return true;
  }
  return false;
}

function addDays(date: string, days: number): string {
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, mo - 1, d + days)).toISOString().slice(0, 10);
}

function weekdayOf(date: string): SupportWeekday {
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
  return SUPPORT_WEEKDAYS[(new Date(Date.UTC(y, mo - 1, d)).getUTCDay() + 6) % 7]!;
}

/** The longest range `businessSeconds` measures. A guard on work done per call, not a business limit. */
export const BUSINESS_SECONDS_MAX_DAYS = 400;

/**
 * Open seconds between `from` and `to` (0 when `to` is not after `from`). Each open span is placed on its local date
 * and converted to real instants in the zone, so a 01:00–04:00 span on a spring-forward night counts two hours. A
 * holiday removes the local calendar date it names, including the after-midnight part of an overnight span.
 */
export function businessSeconds(hours: SupportHours, from: Date, to: Date): number {
  const { zone, intervals } = requireSet(hours);
  if (to.getTime() <= from.getTime()) return 0;
  const firstDate = addDays(localAt(from, zone).date, -1);
  const lastDate = localAt(to, zone).date;
  let total = 0;
  for (let date = firstDate, n = 0; date <= lastDate; date = addDays(date, 1), n += 1) {
    if (n > BUSINESS_SECONDS_MAX_DAYS) throw new RangeError('support.business_seconds_range_too_long');
    const weekday = weekdayOf(date);
    for (const iv of intervals) {
      if (iv.day !== weekday) continue;
      const pieces: [string, number, number][] = iv.closesNextDay
        ? [
            [date, supportHoursMinutes(iv.open), 1440],
            [addDays(date, 1), 0, supportHoursMinutes(iv.close)],
          ]
        : [[date, supportHoursMinutes(iv.open), supportHoursMinutes(iv.close)]];
      for (const [day, startMin, endMin] of pieces) {
        if (hours.holidays.includes(day) || endMin <= startMin) continue;
        const start = instantOf(day, startMin, zone).getTime();
        const end = endMin === 1440 ? instantOf(addDays(day, 1), 0, zone).getTime() : instantOf(day, endMin, zone).getTime();
        const lo = Math.max(start, from.getTime());
        const hi = Math.min(end, to.getTime());
        if (hi > lo) total += hi - lo;
      }
    }
  }
  return Math.round(total / 1000);
}

/**
 * The out-of-hours reply for a request opened at `at`, or null: none when the hours or the text are blank, or the desk
 * is open. Never refuses, so opening a request never fails on the hours.
 */
export function outOfHoursReplyFor(hours: SupportHours, at: Date): string | null {
  if (hours.outOfHoursReply === null || hours.timeZone === null || hours.intervals.length === 0) return null;
  return isOpen(hours, at) ? null : hours.outOfHoursReply;
}

// ── Settings book ────────────────────────────────────────────────────────────

export interface HoursChange {
  readonly value: Pick<SupportHours, 'timeZone' | 'intervals' | 'holidays' | 'outOfHoursReply'>;
  readonly expectedRevision: number;
  readonly by: string;
  readonly reason: string;
  readonly at: string;
}

export interface HoursBook {
  get(): Promise<SupportHours>;
  /** Writes and logs only when something changed. Throws SupportHoursError('support.hours_revision_stale') from a stale revision. */
  set(change: HoursChange): Promise<SupportHours>;
}

/** Canonical value: intervals sorted, holidays sorted, so the same hours compare and fingerprint the same. */
export function canonicalHours(value: HoursChange['value']): HoursChange['value'] {
  const order = (iv: SupportHoursInterval) => SUPPORT_WEEKDAYS.indexOf(iv.day) * 1440 + supportHoursMinutes(iv.open);
  return {
    timeZone: value.timeZone,
    intervals: [...value.intervals]
      .map((iv) => ({ day: iv.day, open: iv.open, close: iv.close, closesNextDay: iv.closesNextDay }))
      .sort((a, b) => order(a) - order(b)),
    holidays: [...value.holidays].sort(),
    outOfHoursReply: value.outOfHoursReply,
  };
}

const valueOf = (h: SupportHours): HoursChange['value'] => ({
  timeZone: h.timeZone,
  intervals: h.intervals,
  holidays: h.holidays,
  outOfHoursReply: h.outOfHoursReply,
});

export function hoursFingerprint(value: HoursChange['value'], reason: string): string {
  return createHash('sha256')
    .update(JSON.stringify([canonicalHours(value), reason]))
    .digest('hex');
}

const sameValue = (a: HoursChange['value'], b: HoursChange['value']): boolean =>
  JSON.stringify(canonicalHours(a)) === JSON.stringify(canonicalHours(b));

export class MemoryHoursBook implements HoursBook {
  private state: SupportHours = blankHours();
  private readonly byKey = new Map<string, string>();
  readonly log: { key: string; before: SupportHours; after: SupportHours; by: string; reason: string }[] = [];

  async get(): Promise<SupportHours> {
    return this.state;
  }

  async set(change: HoursChange): Promise<SupportHours> {
    const key = supportHoursSetKey(change.expectedRevision);
    const fingerprint = hoursFingerprint(change.value, change.reason);
    if (change.expectedRevision !== this.state.revision) {
      if (this.byKey.get(key) === fingerprint) return this.state;
      throw new SupportHoursError('support.hours_revision_stale');
    }
    if (sameValue(valueOf(this.state), change.value)) return this.state;
    const after: SupportHours = { ...canonicalHours(change.value), revision: this.state.revision + 1, updatedAt: change.at };
    this.log.push({ key, before: this.state, after, by: change.by, reason: change.reason });
    this.byKey.set(key, fingerprint);
    this.state = after;
    return after;
  }
}

type Row = {
  time_zone: string | null;
  intervals: SupportHoursInterval[];
  holidays: string[];
  out_of_hours_reply: string | null;
  revision: number;
  updated_at: Date | string | null;
};

const fromRow = (row: Row | undefined): SupportHours =>
  row
    ? {
        timeZone: row.time_zone,
        intervals: row.intervals,
        holidays: row.holidays,
        outOfHoursReply: row.out_of_hours_reply,
        revision: row.revision,
        updatedAt: row.updated_at === null ? null : new Date(row.updated_at).toISOString(),
      }
    : blankHours();

export class SqlHoursBook implements HoursBook {
  constructor(private readonly sql: Sql) {}

  async get(): Promise<SupportHours> {
    const rows = await this.sql<Row[]>`
      SELECT time_zone, intervals, holidays, out_of_hours_reply, revision, updated_at FROM support.business_hours
    `;
    return fromRow(rows[0]);
  }

  async set(change: HoursChange): Promise<SupportHours> {
    const key = supportHoursSetKey(change.expectedRevision);
    const fingerprint = hoursFingerprint(change.value, change.reason);
    return this.sql.begin(async (tx) => {
      // The single row is the lock: every writer serialises on it.
      await tx`INSERT INTO support.business_hours (singleton) VALUES (true) ON CONFLICT DO NOTHING`;
      const [locked] = await tx<Row[]>`
        SELECT time_zone, intervals, holidays, out_of_hours_reply, revision, updated_at
        FROM support.business_hours WHERE singleton FOR UPDATE
      `;
      const prior = fromRow(locked);
      if (change.expectedRevision !== prior.revision) {
        const [logged] = await tx<{ fingerprint: string }[]>`SELECT fingerprint FROM support.business_hours_log WHERE key = ${key}`;
        if (logged?.fingerprint === fingerprint) return prior;
        throw new SupportHoursError('support.hours_revision_stale');
      }
      if (sameValue(valueOf(prior), change.value)) return prior;
      const next = canonicalHours(change.value);
      const after: SupportHours = { ...next, revision: prior.revision + 1, updatedAt: change.at };
      await tx`
        UPDATE support.business_hours
        SET time_zone = ${after.timeZone}, intervals = ${tx.json(after.intervals as never)}, holidays = ${tx.json(after.holidays as never)},
            out_of_hours_reply = ${after.outOfHoursReply}, revision = ${after.revision}, updated_by = ${change.by}, updated_at = ${change.at}
        WHERE singleton
      `;
      await tx`
        INSERT INTO support.business_hours_log (key, fingerprint, revision_after, before, after, set_by, reason, set_at)
        VALUES (${key}, ${fingerprint}, ${after.revision}, ${tx.json(prior as never)}, ${tx.json(after as never)}, ${change.by}, ${change.reason}, ${change.at})
      `;
      return after;
    }) as Promise<SupportHours>;
  }
}

// ── Out-of-hours reply, once per request ─────────────────────────────────────

export interface OutOfHoursReplyBook {
  /** Claims the one reply for this request. True only the first time. */
  claim(ticketId: string, at: string): Promise<boolean>;
}

export class MemoryOutOfHoursReplyBook implements OutOfHoursReplyBook {
  private readonly claimed = new Set<string>();
  async claim(ticketId: string): Promise<boolean> {
    if (this.claimed.has(ticketId)) return false;
    this.claimed.add(ticketId);
    return true;
  }
}

export class SqlOutOfHoursReplyBook implements OutOfHoursReplyBook {
  constructor(private readonly sql: Sql) {}
  async claim(ticketId: string, at: string): Promise<boolean> {
    const rows = await this.sql`
      INSERT INTO support.out_of_hours_replies (ticket_id, replied_at) VALUES (${ticketId}, ${at})
      ON CONFLICT (ticket_id) DO NOTHING RETURNING ticket_id
    `;
    return rows.length === 1;
  }
}
