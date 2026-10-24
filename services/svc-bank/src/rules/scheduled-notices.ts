/**
 * Payment reminders, standing-order failure notices and the rules that would move money (BK-acct-10, J-bank-06 #6).
 *
 * A person sets one reminder rule, business key `reminder:<userId>`: how long before each of their standing orders runs
 * they want to hear about it, from fixed choices, or off. The rule moves nothing. A failure notice needs no rule: a run
 * the runner refused (too little money, a locked space) is told to its owner once.
 *
 * Both kinds go through one outbox, `bank.scheduled_notices`, one row per (schedule, occurrence, kind). The job writes
 * what is owed, then publishes each owed row and marks it announced only once the bus took it. So a job retried, or two
 * passes at once, tell a person once, and a publish that failed is sent on the next pass. svc-notify writes the inbox
 * notice from the event and follows the person's notification choices for the `orders` category.
 *
 * Rules that move money by themselves (auto-transfer, sweep, income split) are on the owner's decision list: until the
 * owner publishes their terms, creating one refuses `bank.rule_terms_unset` and nothing is stored.
 *
 * If this crashes exactly here, whose funds are stranded? No one's: nothing here posts to the ledger.
 */
import type { Sql } from 'postgres';
import type { EventBus } from '@intafaced/events';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { BankError } from '../errors.js';
import { occurrencesIn } from '../calendar/calendar.js';
import type { ScheduleCadence } from '../transfers/schedule.js';

/** The lead times a person can choose, in hours: one, two, three or seven days before a run. */
export const REMINDER_LEAD_HOURS = [24, 48, 72, 168] as const;
export type ReminderLeadHours = (typeof REMINDER_LEAD_HOURS)[number];

/** No owner terms for rules that move money by themselves, so none can be created. */
export const RULE_TERMS_UNSET = 'bank.rule_terms_unset';

/** A failure older than this when the job first sees it is left to the run history; it is not news any more. */
export const FAILURE_NOTICE_LOOKBACK_MS = 7 * 86_400_000;
const NOTICE_PUBLISH_TIMEOUT_MS = 5_000;

export interface ReminderRule {
  readonly ruleKey: string;
  /** Null when reminders are off. */
  readonly leadHours: ReminderLeadHours | null;
  readonly revision: number;
  readonly updatedAt: string;
}

export interface ScheduledReminderNotice {
  readonly noticeId: string;
  readonly userId: string;
  readonly scheduleId: string;
  readonly occurrence: number;
  readonly dueAt: string;
  readonly amount: string;
  readonly assetId: string;
  readonly leadHours: number;
}

export interface ScheduledFailedNotice {
  readonly noticeId: string;
  readonly userId: string;
  readonly scheduleId: string;
  readonly occurrence: number;
  readonly amount: string;
  readonly assetId: string;
  readonly reasonCode: string;
  readonly failedAt: string;
}

export interface ScheduledNoticeSink {
  reminder(notice: ScheduledReminderNotice): Promise<void>;
  failed(notice: ScheduledFailedNotice): Promise<void>;
}

export function eventScheduledNotices(bus: EventBus): ScheduledNoticeSink {
  return {
    async reminder(n) {
      await bus.publish('bankScheduledReminder', { ...n }, { idempotencyKey: `bank.scheduled_reminder:${n.scheduleId}:${n.occurrence}` });
    },
    async failed(n) {
      await bus.publish('bankScheduledFailed', { ...n }, { idempotencyKey: `bank.scheduled_failed:${n.scheduleId}:${n.occurrence}` });
    },
  };
}

export interface ScheduledNoticePass {
  /** Reminders newly owed by this pass. */
  readonly reminders: number;
  /** Failure notices newly owed by this pass. */
  readonly failures: number;
  /** Owed notices the bus took. */
  readonly announced: number;
  /** Owed notices still waiting for the bus after this pass. */
  readonly owed: number;
}

type RuleRow = {
  user_id: string;
  rule_key: string;
  lead_hours: number | null;
  revision: number;
  client_request_id: string;
  updated_at: Date;
};

type NoticeRow = {
  id: string;
  schedule_id: string;
  occurrence: number;
  kind: 'reminder' | 'failed';
  user_id: string;
  due_at: Date;
  lead_hours: number | null;
  reason_code: string | null;
  asset_id: string;
  amount: string;
};

export function isReminderLead(value: unknown): value is ReminderLeadHours {
  return (REMINDER_LEAD_HOURS as readonly unknown[]).includes(value);
}

function toRule(row: RuleRow): ReminderRule {
  return {
    ruleKey: row.rule_key,
    leadHours: isReminderLead(row.lead_hours) ? row.lead_hours : null,
    revision: row.revision,
    updatedAt: row.updated_at.toISOString(),
  };
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`notice publish timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class ScheduledNoticeService {
  constructor(
    private readonly sql: Sql,
    private readonly options: {
      sink?: ScheduledNoticeSink;
      publishTimeoutMs?: number;
      log?: (event: string, detail: unknown) => void;
    } = {},
  ) {}

  /** The person's reminder rule, or null when they never set one (reminders are then off). */
  async reminderRule(userId: string): Promise<ReminderRule | null> {
    const rows = await this.sql<RuleRow[]>`
      SELECT user_id, rule_key, lead_hours, revision, client_request_id, updated_at
        FROM bank.reminder_rules WHERE user_id = ${userId}
    `;
    return rows[0] ? toRule(rows[0]) : null;
  }

  /**
   * Save the person's reminder rule. The caller names the revision it read (0 when there is no rule yet), so of two
   * writes sent at the same revision one lands and the other refuses `bank.reminder_revision_conflict`. The same write
   * sent again (same `clientRequestId`) reads back the row it made.
   */
  async setReminderRule(input: {
    userId: string;
    leadHours: number | null;
    expectedRevision: number;
    clientRequestId: string;
  }): Promise<ReminderRule> {
    if (input.leadHours !== null && !isReminderLead(input.leadHours)) {
      throw new BankError(`A reminder lead time is one of ${REMINDER_LEAD_HOURS.join(', ')} hours, or off`, 'bank.reminder_lead_invalid');
    }
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) {
      throw new BankError('A reminder rule write names the revision it read', 'bank.reminder_lead_invalid');
    }
    const key = `reminder:${input.userId}`;
    const written =
      input.expectedRevision === 0
        ? await this.sql<RuleRow[]>`
            INSERT INTO bank.reminder_rules (user_id, rule_key, lead_hours, revision, client_request_id)
            VALUES (${input.userId}, ${key}, ${input.leadHours}, 1, ${input.clientRequestId})
            ON CONFLICT (user_id) DO NOTHING
            RETURNING user_id, rule_key, lead_hours, revision, client_request_id, updated_at
          `
        : await this.sql<RuleRow[]>`
            UPDATE bank.reminder_rules
               SET lead_hours = ${input.leadHours}, revision = revision + 1,
                   client_request_id = ${input.clientRequestId}, updated_at = now()
             WHERE user_id = ${input.userId} AND revision = ${input.expectedRevision}
            RETURNING user_id, rule_key, lead_hours, revision, client_request_id, updated_at
          `;
    if (written[0]) return toRule(written[0]);
    const current = await this.sql<RuleRow[]>`
      SELECT user_id, rule_key, lead_hours, revision, client_request_id, updated_at
        FROM bank.reminder_rules WHERE user_id = ${input.userId}
    `;
    const row = current[0];
    if (row && row.client_request_id === input.clientRequestId) return toRule(row);
    throw new BankError(
      `The reminder rule changed since revision ${input.expectedRevision}; read it again before saving`,
      'bank.reminder_revision_conflict',
    );
  }

  /** Rules that move money by themselves wait for the owner's terms; nothing is stored. */
  createMoneyRule(): never {
    throw new BankError(
      'Rules that move money by themselves are not open: their terms (allowed targets, a cap per rule) are not published',
      RULE_TERMS_UNSET,
    );
  }

  /**
   * One pass of the notice job: owe a reminder for each active standing order whose next run falls inside its owner's
   * lead time, owe a failure notice for each run refused in the last week, then publish what is owed, oldest first.
   * `limit` bounds each of the three steps.
   */
  async run(input: { limit: number; now?: Date }): Promise<ScheduledNoticePass> {
    const now = input.now ?? new Date();
    const reminders = await this.oweReminders(input.limit, now);
    const failures = await this.oweFailures(input.limit, now);
    const announced = await this.announceOwed(input.limit);
    const [{ owed }] = await this.sql<[{ owed: number }]>`
      SELECT count(*)::int AS owed FROM bank.scheduled_notices WHERE announced_at IS NULL
    `;
    return { reminders, failures, announced, owed };
  }

  private async oweReminders(limit: number, now: Date): Promise<number> {
    // Orders whose next run is still ahead and inside the owner's lead time, with no reminder for that run yet. The run
    // date is the order's `next_run_at`, so "no reminder yet" is a lookup by that date and a pass never re-reads rows it
    // already owed.
    const due = await this.sql<
      Array<{
        id: string;
        user_id: string;
        starts_at: Date;
        ends_at: Date | null;
        cadence: ScheduleCadence;
        next_run_at: Date;
        lead_hours: number;
      }>
    >`
      SELECT s.id, s.user_id, s.starts_at, s.ends_at, s.cadence, s.next_run_at, r.lead_hours
        FROM bank.scheduled_transfers s
        JOIN bank.reminder_rules r ON r.user_id = s.user_id
       WHERE r.lead_hours IS NOT NULL
         AND s.status = 'active'
         AND s.next_run_at > ${now}
         AND s.next_run_at <= ${now}::timestamptz + make_interval(hours => r.lead_hours)
         AND NOT EXISTS (
           SELECT 1 FROM bank.scheduled_notices n
            WHERE n.schedule_id = s.id AND n.kind = 'reminder' AND n.due_at = s.next_run_at
         )
       ORDER BY s.next_run_at
       LIMIT ${limit}
    `;
    let owed = 0;
    for (const s of due) {
      const [run] = occurrencesIn(
        { startsAt: s.starts_at, cadence: s.cadence, endsAt: s.ends_at },
        s.next_run_at,
        new Date(s.next_run_at.getTime() + 1),
      );
      if (!run) continue; // the next run is past the order's end: nothing will run, so nothing to remind of
      const inserted = await this.sql`
        INSERT INTO bank.scheduled_notices (schedule_id, occurrence, kind, user_id, due_at, lead_hours)
        VALUES (${s.id}, ${run.n}, 'reminder', ${s.user_id}, ${run.at}, ${s.lead_hours})
        ON CONFLICT (schedule_id, occurrence, kind) DO NOTHING
      `;
      owed += inserted.count;
    }
    return owed;
  }

  private async oweFailures(limit: number, now: Date): Promise<number> {
    const since = new Date(now.getTime() - FAILURE_NOTICE_LOOKBACK_MS);
    const inserted = await this.sql`
      INSERT INTO bank.scheduled_notices (schedule_id, occurrence, kind, user_id, due_at, reason_code)
      SELECT e.schedule_id, e.occurrence, 'failed', s.user_id, e.attempted_at, e.rejection_code
        FROM bank.transfer_executions e
        JOIN bank.scheduled_transfers s ON s.id = e.schedule_id
       WHERE e.status = 'rejected' AND e.rejection_code IS NOT NULL
         AND e.attempted_at >= ${since}
         AND NOT EXISTS (
           SELECT 1 FROM bank.scheduled_notices n
            WHERE n.schedule_id = e.schedule_id AND n.occurrence = e.occurrence AND n.kind = 'failed'
         )
       ORDER BY e.attempted_at
       LIMIT ${limit}
      ON CONFLICT (schedule_id, occurrence, kind) DO NOTHING
    `;
    return inserted.count;
  }

  /**
   * Publish owed notices, oldest first. A row is marked announced only after the bus took it; a publish that fails or
   * hangs leaves it owed for the next pass. Redelivery is safe: each event's business key is its schedule, occurrence
   * and kind, and svc-notify dedupes on it. With no bus wired, every row stays owed and the job says so.
   */
  private async announceOwed(limit: number): Promise<number> {
    const rows = await this.sql<NoticeRow[]>`
      SELECT n.id, n.schedule_id, n.occurrence, n.kind, n.user_id, n.due_at, n.lead_hours, n.reason_code,
             s.asset_id, COALESCE(e.amount, s.amount)::text AS amount
        FROM bank.scheduled_notices n
        JOIN bank.scheduled_transfers s ON s.id = n.schedule_id
        LEFT JOIN bank.transfer_executions e ON n.kind = 'failed' AND e.schedule_id = n.schedule_id AND e.occurrence = n.occurrence
       WHERE n.announced_at IS NULL
       ORDER BY n.created_at
       LIMIT ${limit}
    `;
    if (rows.length === 0) return 0;
    const sink = this.options.sink;
    if (!sink) {
      throw new BankError(
        'svc-notify is not wired for standing-order notices, so owed reminders and failures stay owed (bank.scheduled_notify_unwired)',
        'bank.scheduled_notify_unwired',
      );
    }
    let announced = 0;
    for (const row of rows) {
      const amount = formatAmount(parseAmount(row.amount));
      try {
        const publish =
          row.kind === 'reminder'
            ? sink.reminder({
                noticeId: row.id,
                userId: row.user_id,
                scheduleId: row.schedule_id,
                occurrence: row.occurrence,
                dueAt: row.due_at.toISOString(),
                amount,
                assetId: row.asset_id,
                leadHours: row.lead_hours ?? 0,
              })
            : sink.failed({
                noticeId: row.id,
                userId: row.user_id,
                scheduleId: row.schedule_id,
                occurrence: row.occurrence,
                amount,
                assetId: row.asset_id,
                reasonCode: row.reason_code ?? '',
                failedAt: row.due_at.toISOString(),
              });
        await withTimeout(publish, this.options.publishTimeoutMs ?? NOTICE_PUBLISH_TIMEOUT_MS);
        const marked = await this.sql`
          UPDATE bank.scheduled_notices SET announced_at = now() WHERE id = ${row.id} AND announced_at IS NULL
        `;
        announced += marked.count;
      } catch (err) {
        this.options.log?.('bank.scheduled_notice_failed', { noticeId: row.id, detail: err instanceof Error ? err.message : String(err) });
      }
    }
    return announced;
  }
}
