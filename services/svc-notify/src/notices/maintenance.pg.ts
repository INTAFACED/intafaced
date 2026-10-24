/** Postgres store for the maintenance lifecycle, on the tables of 0032_notify_maintenance_lifecycle.sql. */
import type { Sql } from 'postgres';
import type { MaintenanceCode, MaintenanceMove, MaintenanceMoveState, MaintenanceStore, ReminderRow } from './maintenance.js';

type MovePg = { notice_id: string; state: MaintenanceMoveState; moved_by: string; reason: string; moved_at: Date };
type ReminderPg = {
  notice_id: string;
  offset_minutes: number;
  due_at: Date;
  sent_at: Date | null;
  skipped: ReminderRow['skipped'];
};

const fromMove = (row: MovePg): MaintenanceMove => ({
  noticeId: row.notice_id,
  state: row.state,
  movedBy: row.moved_by,
  reason: row.reason,
  movedAt: row.moved_at,
});

const fromReminder = (row: ReminderPg): ReminderRow => ({
  noticeId: row.notice_id,
  offsetMinutes: row.offset_minutes,
  dueAt: row.due_at,
  sentAt: row.sent_at,
  skipped: row.skipped,
});

export class SqlMaintenanceStore implements MaintenanceStore {
  constructor(private readonly sql: Sql) {}

  async moves(noticeId: string): Promise<readonly MaintenanceMove[]> {
    return this.movesOf([noticeId]);
  }

  async movesOf(noticeIds: readonly string[]): Promise<readonly MaintenanceMove[]> {
    if (noticeIds.length === 0) return [];
    const rows = await this.sql<MovePg[]>`
      SELECT notice_id, state, moved_by, reason, moved_at FROM notify.maintenance_moves
       WHERE notice_id = ANY(${this.sql.array([...noticeIds])}::uuid[]) ORDER BY moved_at, state
    `;
    return rows.map(fromMove);
  }

  async closedAmong(noticeIds: readonly string[]): Promise<ReadonlySet<string>> {
    if (noticeIds.length === 0) return new Set();
    const rows = await this.sql<{ notice_id: string }[]>`
      SELECT DISTINCT notice_id FROM notify.maintenance_moves
       WHERE notice_id = ANY(${this.sql.array([...noticeIds])}::uuid[]) AND state IN ('completed', 'cancelled')
    `;
    return new Set(rows.map((r) => r.notice_id));
  }

  async applyMove(
    move: MaintenanceMove,
    allowed: (moves: readonly MaintenanceMove[]) => MaintenanceCode | 'replay' | null,
  ): Promise<readonly MaintenanceMove[] | MaintenanceCode> {
    return this.sql.begin(async (tx) => {
      // The window's row is the lock every move takes, so two moves at once are decided one after the other.
      await tx`SELECT id FROM notify.notices WHERE id = ${move.noticeId} FOR UPDATE`;
      const current = (
        await tx<MovePg[]>`
          SELECT notice_id, state, moved_by, reason, moved_at FROM notify.maintenance_moves
           WHERE notice_id = ${move.noticeId} ORDER BY moved_at, state
        `
      ).map(fromMove);
      const verdict = allowed(current);
      if (verdict === 'replay') return current;
      if (verdict) return verdict;
      await tx`
        INSERT INTO notify.maintenance_moves (notice_id, state, moved_by, reason, moved_at)
        VALUES (${move.noticeId}, ${move.state}, ${move.movedBy}, ${move.reason}, ${move.movedAt})
      `;
      return [...current, move];
    });
  }

  async schedule(
    noticeId: string,
    reminders: readonly { offsetMinutes: number; dueAt: Date; skipped: 'published_late' | null }[],
  ): Promise<void> {
    if (reminders.length === 0) return;
    await this.sql`
      INSERT INTO notify.maintenance_reminders (notice_id, offset_minutes, due_at, skipped)
      SELECT ${noticeId}::uuid, r.offset_minutes, r.due_at, NULLIF(r.skipped, '')
        FROM unnest(
          ${this.sql.array(reminders.map((r) => r.offsetMinutes))}::integer[],
          ${this.sql.array(reminders.map((r) => r.dueAt.toISOString()))}::timestamptz[],
          ${this.sql.array(reminders.map((r) => r.skipped ?? ''))}::text[]
        ) AS r(offset_minutes, due_at, skipped)
      ON CONFLICT (notice_id, offset_minutes) DO NOTHING
    `;
  }

  async remindersOf(noticeIds: readonly string[]): Promise<readonly ReminderRow[]> {
    if (noticeIds.length === 0) return [];
    const rows = await this.sql<ReminderPg[]>`
      SELECT notice_id, offset_minutes, due_at, sent_at, skipped FROM notify.maintenance_reminders
       WHERE notice_id = ANY(${this.sql.array([...noticeIds])}::uuid[])
    `;
    return rows.map(fromReminder);
  }

  async claimDue(at: Date, until: Date, limit: number): Promise<readonly ReminderRow[]> {
    const rows = await this.sql<ReminderPg[]>`
      UPDATE notify.maintenance_reminders r SET claimed_until = ${until}
        FROM (
          SELECT notice_id, offset_minutes FROM notify.maintenance_reminders
           WHERE sent_at IS NULL AND skipped IS NULL AND due_at <= ${at}
             AND (claimed_until IS NULL OR claimed_until <= ${at})
           ORDER BY due_at
           LIMIT ${limit}
           FOR UPDATE SKIP LOCKED
        ) due
       WHERE r.notice_id = due.notice_id AND r.offset_minutes = due.offset_minutes
      RETURNING r.notice_id, r.offset_minutes, r.due_at, r.sent_at, r.skipped
    `;
    return rows.map(fromReminder);
  }

  async settle(
    noticeId: string,
    offsetMinutes: number,
    outcome: { sentAt: Date } | { skipped: NonNullable<ReminderRow['skipped']> },
  ): Promise<void> {
    if ('sentAt' in outcome)
      await this.sql`
        UPDATE notify.maintenance_reminders SET sent_at = ${outcome.sentAt}, claimed_until = NULL
         WHERE notice_id = ${noticeId} AND offset_minutes = ${offsetMinutes} AND sent_at IS NULL AND skipped IS NULL
      `;
    else
      await this.sql`
        UPDATE notify.maintenance_reminders SET skipped = ${outcome.skipped}, claimed_until = NULL
         WHERE notice_id = ${noticeId} AND offset_minutes = ${offsetMinutes} AND sent_at IS NULL AND skipped IS NULL
      `;
  }
}
