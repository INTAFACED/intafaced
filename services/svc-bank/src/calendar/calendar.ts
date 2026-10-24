import type { Sql } from 'postgres';
import { formatAmount } from '@intafaced/ledger-client';
import { BankError } from '../errors.js';
import { PersonalPayError } from '../personal-pay/errors.js';
import type { BillPayService } from '../personal-pay/bills.js';
import type { DirectDebitService } from '../direct-debits/direct-debits.js';
import type { EarnService } from '../earn/earn-service.js';
import type { LoanService } from '../loans/loan-service.js';
import type { TransferService } from '../transfers/transfer-service.js';
import { occurrenceStart, type ScheduleCadence } from '../transfers/schedule.js';

/**
 * The money calendar (BK-acct-10, J-bank-06 #5): one read of what is dated in a window, merged from svc-bank's own
 * sources. Standing orders and recurring bills give each occurrence from their own schedule arithmetic, with a run that
 * already happened shown as it ended; direct debits give each collection by its due date; fixed-term earn positions
 * give their maturity. A loan has no repayment schedule (none is published), so loans contribute nothing and say so.
 *
 * Read only: the calendar posts nothing and writes nothing. Each source is read on its own, so a source that fails names
 * itself and the others still show.
 */

export const CALENDAR_SOURCES = ['standing_orders', 'bills', 'direct_debits', 'loans', 'earn'] as const;
export type CalendarSource = (typeof CALENDAR_SOURCES)[number];

export const CALENDAR_ITEM_STATUSES = ['upcoming', 'paused', 'done', 'failed', 'skipped', 'refused'] as const;
export type CalendarItemStatus = (typeof CALENDAR_ITEM_STATUSES)[number];

/** No loan product publishes repayment dates, so a loan has none to show. */
export const LOAN_SCHEDULE_UNSET = 'bank.loan_schedule_unset';
/** A source failed for a reason that is not a refusal (an outage, a bug). Its error is logged, never shown. */
export const CALENDAR_SOURCE_UNAVAILABLE = 'bank.calendar_source_unavailable';

/** The widest window one read may ask for: two months, so a month view and its edges fit. */
export const CALENDAR_MAX_DAYS = 62;

const DAY_MS = 86_400_000;
const OPEN_LOANS = new Set(['active', 'margin_call', 'liquidating']);

export interface CalendarItem {
  readonly source: CalendarSource;
  /** The record the item opens: a schedule, a recurring bill, a direct debit mandate or an earn position. */
  readonly refId: string;
  /** Which occurrence or collection of that record, so two items of one record never share a key. */
  readonly key: string;
  readonly date: string;
  /** The creditor or bill reference as the person set it; null where the record has no name of its own. */
  readonly label: string | null;
  readonly assetId: string;
  readonly amount: string | null;
  readonly status: CalendarItemStatus;
  /** Why a run failed, was skipped or was refused, as its own code. */
  readonly reasonCode: string | null;
}

export interface CalendarSourceReport {
  readonly source: CalendarSource;
  /** `ok` with its items; `not_set` when the owner publishes no dates for it; `refused` or `unavailable` when it failed. */
  readonly state: 'ok' | 'not_set' | 'refused' | 'unavailable';
  readonly count: number;
  /** The refusal, the missing setting, or on `ok` a note the page shows beside the source (no bill partner, say). */
  readonly code: string | null;
  /** False when the source filled its whole page, so records past it may be missing; the page says so. */
  readonly complete: boolean;
}

export interface CalendarView {
  readonly from: string;
  readonly to: string;
  readonly items: CalendarItem[];
  readonly sources: CalendarSourceReport[];
}

export interface CalendarDeps {
  readonly sql: Sql;
  readonly transfers: Pick<TransferService, 'listSchedules'>;
  readonly bills: Pick<BillPayService, 'listRecurring' | 'railStatus'>;
  readonly directDebits: Pick<DirectDebitService, 'dated'>;
  readonly earn: Pick<EarnService, 'positionsOf'>;
  readonly loans: Pick<LoanService, 'loansOf'>;
  readonly log?: (source: CalendarSource, err: unknown) => void;
}

type SourceResult = { items: CalendarItem[]; full: boolean; state?: 'ok' | 'not_set'; count?: number; code?: string | null };

/** The first occurrence index whose date can fall on or after `from`; a little early is fine, the loop skips it. */
function firstIndex(startsAt: Date, cadence: ScheduleCadence, from: Date): number {
  const gap = from.getTime() - startsAt.getTime();
  if (gap <= 0) return 0;
  switch (cadence) {
    case 'once':
      return 0;
    case 'daily':
      return Math.max(0, Math.floor(gap / DAY_MS) - 1);
    case 'weekly':
      return Math.max(0, Math.floor(gap / (7 * DAY_MS)) - 1);
    case 'monthly': {
      const months = (from.getUTCFullYear() - startsAt.getUTCFullYear()) * 12 + (from.getUTCMonth() - startsAt.getUTCMonth());
      return Math.max(0, months - 1);
    }
  }
}

/** Each occurrence of a schedule dated inside `[from, to)` and before its end (the runner's end is exclusive), with its index. */
export function occurrencesIn(
  schedule: { startsAt: Date; cadence: ScheduleCadence; endsAt: Date | null },
  from: Date,
  to: Date,
): Array<{ n: number; at: Date }> {
  const out: Array<{ n: number; at: Date }> = [];
  const last = schedule.cadence === 'once' ? 0 : Number.MAX_SAFE_INTEGER;
  // The window is at most CALENDAR_MAX_DAYS, so a daily schedule gives at most that many and the bound never bites.
  for (
    let n = firstIndex(schedule.startsAt, schedule.cadence, from), seen = 0;
    n <= last && seen < 4 * CALENDAR_MAX_DAYS;
    n += 1, seen += 1
  ) {
    const at = occurrenceStart(schedule.startsAt, schedule.cadence, n);
    if (at.getTime() >= to.getTime()) break;
    if (schedule.endsAt && at.getTime() >= schedule.endsAt.getTime()) break;
    if (at.getTime() >= from.getTime()) out.push({ n, at });
  }
  return out;
}

function refusalCode(err: unknown): string | null {
  if (err instanceof BankError || err instanceof PersonalPayError) return err.code;
  return null;
}

export class CalendarService {
  constructor(private readonly deps: CalendarDeps) {}

  /**
   * What is dated in `[from, from + days)` for this person, soonest first, and how each source answered. `limit` is the
   * page size each source reads with; it is passed on, never assumed.
   */
  async window(input: { userId: string; from: Date; days: number; limit: number; now?: Date }): Promise<CalendarView> {
    if (!Number.isInteger(input.days) || input.days < 1 || input.days > CALENDAR_MAX_DAYS || Number.isNaN(input.from.getTime())) {
      throw new BankError(`A calendar window is 1 to ${CALENDAR_MAX_DAYS} days from a valid date`, 'bank.calendar_window_invalid');
    }
    const now = input.now ?? new Date();
    const from = input.from;
    const to = new Date(from.getTime() + input.days * DAY_MS);
    const read: Record<CalendarSource, () => Promise<SourceResult>> = {
      standing_orders: () => this.standingOrders(input.userId, from, to, input.limit, now),
      bills: () => this.bills(input.userId, from, to, input.limit, now),
      direct_debits: () => this.directDebits(input.userId, from, to, input.limit, now),
      loans: () => this.loans(input.userId, input.limit),
      earn: () => this.earn(input.userId, from, to, input.limit),
    };
    const answers = await Promise.all(
      CALENDAR_SOURCES.map(async (source) => {
        try {
          return { source, result: await read[source]() };
        } catch (err) {
          const code = refusalCode(err);
          if (code === null) this.deps.log?.(source, err);
          return { source, failed: code ?? CALENDAR_SOURCE_UNAVAILABLE, refused: code !== null };
        }
      }),
    );
    const items: CalendarItem[] = [];
    const sources: CalendarSourceReport[] = [];
    for (const answer of answers) {
      if ('result' in answer && answer.result) {
        items.push(...answer.result.items);
        sources.push({
          source: answer.source,
          state: answer.result.state ?? 'ok',
          count: answer.result.count ?? answer.result.items.length,
          code: answer.result.code ?? null,
          complete: !answer.result.full,
        });
      } else if ('failed' in answer) {
        sources.push({
          source: answer.source,
          state: answer.refused ? 'refused' : 'unavailable',
          count: 0,
          code: answer.failed,
          complete: false,
        });
      }
    }
    items.sort((a, b) => a.date.localeCompare(b.date) || a.source.localeCompare(b.source) || a.key.localeCompare(b.key));
    return { from: from.toISOString(), to: to.toISOString(), items, sources };
  }

  private async standingOrders(userId: string, from: Date, to: Date, limit: number, now: Date): Promise<SourceResult> {
    const schedules = await this.deps.transfers.listSchedules(userId, limit);
    const full = schedules.length >= limit;
    const dated = schedules.flatMap((s) => occurrencesIn(s, from, to).map((o) => ({ s, ...o })));
    if (dated.length === 0) return { items: [], full };
    const runs = await this.deps.sql<Array<{ schedule_id: string; occurrence: number; status: string; rejection_code: string | null }>>`
      SELECT e.schedule_id, e.occurrence, e.status, e.rejection_code
        FROM bank.transfer_executions e
        JOIN unnest(${dated.map((d) => d.s.id)}::uuid[], ${dated.map((d) => d.n)}::int[]) AS w(schedule_id, occurrence)
          ON w.schedule_id = e.schedule_id AND w.occurrence = e.occurrence
    `;
    const ran = new Map(runs.map((r) => [`${r.schedule_id}:${r.occurrence}`, r]));
    const items: CalendarItem[] = [];
    for (const { s, n, at } of dated) {
      const run = ran.get(`${s.id}:${n}`);
      let status: CalendarItemStatus;
      if (run) {
        status =
          run.status === 'settled' ? 'done' : run.status === 'rejected' ? 'failed' : run.status === 'skipped' ? 'skipped' : 'upcoming';
      } else if (s.status === 'active' && at.getTime() >= s.nextRunAt.getTime()) {
        // Due, or overdue and waiting for the runner to catch up. A date before the next run with no run of its own
        // never ran and never will, so it is left out rather than shown as due.
        status = 'upcoming';
      } else if (s.status === 'paused' && at.getTime() >= now.getTime()) {
        status = 'paused';
      } else {
        continue; // cancelled, completed or a paused past date: nothing will run and nothing ran
      }
      items.push({
        source: 'standing_orders',
        refId: s.id,
        key: `${s.id}:${n}`,
        date: at.toISOString(),
        label: null,
        assetId: s.assetId,
        amount: formatAmount(s.amount),
        status,
        reasonCode: run?.rejection_code ?? null,
      });
    }
    return { items, full };
  }

  private async bills(userId: string, from: Date, to: Date, limit: number, now: Date): Promise<SourceResult> {
    const recurring = await this.deps.bills.listRecurring({ userId, limit });
    const items: CalendarItem[] = [];
    for (const r of recurring) {
      if (r.status !== 'active' && r.status !== 'paused') continue;
      const next = new Date(r.nextRunAt).getTime();
      const schedule = { startsAt: new Date(r.startsAt), cadence: r.cadence, endsAt: r.endsAt ? new Date(r.endsAt) : null };
      for (const { n, at } of occurrencesIn(schedule, from, to)) {
        // A bill's past runs are its payments, read in its own room; the calendar shows what is still to come. A paused
        // bill's past dates will never run, so like a paused standing order it shows only its future ones.
        if (at.getTime() < next) continue;
        if (r.status === 'paused' && at.getTime() < now.getTime()) continue;
        items.push({
          source: 'bills',
          refId: r.id,
          key: `${r.id}:${n}`,
          date: at.toISOString(),
          label: r.reference,
          assetId: r.assetId,
          amount: r.amount,
          status: r.status === 'active' ? 'upcoming' : 'paused',
          reasonCode: null,
        });
      }
    }
    // With no bill partner a recurring bill cannot be set up, so an empty source says why rather than looking idle.
    return { items, full: recurring.length >= limit, code: this.deps.bills.railStatus() === 'live' ? null : 'bank.bills_psp_unset' };
  }

  private async directDebits(userId: string, from: Date, to: Date, limit: number, now: Date): Promise<SourceResult> {
    const rows = await this.deps.directDebits.dated({ userId, from, to, limit, now });
    return {
      full: rows.length >= limit,
      items: rows.map((c) => ({
        source: 'direct_debits' as const,
        refId: c.mandateId,
        key: c.id,
        date: c.dueAt,
        label: c.creditorName,
        assetId: c.assetId,
        amount: c.amount,
        status: c.status === 'collected' ? 'done' : c.status === 'failed' ? 'failed' : c.status === 'rejected' ? 'refused' : 'upcoming',
        reasonCode: c.failureCode,
      })),
    };
  }

  private async loans(userId: string, limit: number): Promise<SourceResult> {
    const loans = await this.deps.loans.loansOf(userId, limit);
    return {
      items: [],
      full: loans.length >= limit,
      state: 'not_set',
      count: loans.filter((l) => OPEN_LOANS.has(l.status)).length,
      code: LOAN_SCHEDULE_UNSET,
    };
  }

  private async earn(userId: string, from: Date, to: Date, limit: number): Promise<SourceResult> {
    const positions = await this.deps.earn.positionsOf(userId, limit);
    const items: CalendarItem[] = [];
    for (const p of positions) {
      if (p.status !== 'active' || !p.maturesAt) continue;
      const at = p.maturesAt.getTime();
      if (at < from.getTime() || at >= to.getTime()) continue;
      items.push({
        source: 'earn',
        refId: p.id,
        key: p.id,
        date: p.maturesAt.toISOString(),
        label: null,
        assetId: p.assetId,
        amount: formatAmount(p.principal),
        // An active position past its date has matured but its money has not been paid back: it is due, not done.
        status: 'upcoming',
        reasonCode: null,
      });
    }
    return { items, full: positions.length >= limit };
  }
}
