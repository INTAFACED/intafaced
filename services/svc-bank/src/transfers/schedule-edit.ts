import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import { formatAmount, type Amount } from '@intafaced/ledger-client';
import { BankError } from '../errors.js';
import { planDue, type ScheduleCadence } from './schedule.js';

/**
 * BK-xfer-10: edit a standing order IN PLACE (same id, so the ledger key `bank.transfer.sched:<id>:<occurrence>` keeps
 * collapsing retries), idempotent by (scheduleId, revision read).
 *
 * The recipient and source space are not editable. The edit cutoff is an owner value and is never defaulted: blank
 * refuses every edit with `bank.schedule_cutoff_unset`; inside the cutoff before the next run it refuses
 * `bank.schedule_cutoff`. The runner reads the amount from the locked row, so an edit that wins the lock is what the
 * next occurrence moves, and one that loses waits for the run to finish.
 */
export interface ScheduleEditInput {
  scheduleId: string;
  userId: string;
  revision: number;
  amount?: Amount;
  cadence?: ScheduleCadence;
  reference?: string;
  endsAt?: Date | null;
  now?: Date;
}

export interface ScheduleEditResult {
  scheduleId: string;
  revision: number;
  nextRunAt: Date | null;
}

export class ScheduleEditor {
  constructor(
    private readonly sql: Sql,
    private readonly options: { editCutoffMinutes?: number } = {},
  ) {}

  async update(input: ScheduleEditInput): Promise<ScheduleEditResult> {
    if (input.amount !== undefined && input.amount <= 0n) throw new BankError('Amount must be positive', 'bank.below_minimum');
    const now = input.now ?? new Date();
    const hash = createHash('sha256')
      .update(
        JSON.stringify([
          input.amount === undefined ? null : formatAmount(input.amount),
          input.cadence ?? null,
          input.reference ?? null,
          input.endsAt === undefined ? 'keep' : (input.endsAt?.toISOString() ?? null),
        ]),
      )
      .digest('hex');

    return transaction(
      this.sql,
      async (tx) => {
        const rows = await tx<
          Array<{
            user_id: string;
            amount: string;
            cadence: ScheduleCadence;
            starts_at: Date;
            ends_at: Date | null;
            next_run_at: Date;
            status: string;
            revision: number;
          }>
        >`
          SELECT user_id, amount, cadence, starts_at, ends_at, next_run_at, status, revision
            FROM bank.scheduled_transfers WHERE id = ${input.scheduleId} FOR UPDATE
        `;
        const row = rows[0];
        if (!row) throw new BankError(`Schedule ${input.scheduleId} not found`, 'bank.schedule_not_found');
        if (row.user_id !== input.userId) throw new BankError('Not your schedule', 'bank.not_owner');

        // Same edit again: the record says it already applied. Return the current state, change nothing.
        const prior = await tx<Array<{ payload_hash: string }>>`
          SELECT payload_hash FROM bank.schedule_edits WHERE schedule_id = ${input.scheduleId} AND from_revision = ${input.revision}
        `;
        if (prior[0]) {
          if (prior[0].payload_hash !== hash) {
            throw new BankError('This revision was already edited with different terms', 'bank.schedule_revision_conflict');
          }
          return { scheduleId: input.scheduleId, revision: row.revision, nextRunAt: row.status === 'active' ? row.next_run_at : null };
        }
        if (row.revision !== input.revision) {
          throw new BankError(`Schedule is at revision ${row.revision}, not ${input.revision}`, 'bank.schedule_revision_conflict');
        }
        if (row.status !== 'active' && row.status !== 'paused') {
          throw new BankError(`Schedule ${input.scheduleId} is ${row.status}`, 'bank.schedule_inactive');
        }
        if (this.options.editCutoffMinutes === undefined) {
          throw new BankError('No edit cutoff is set; schedules cannot be edited', 'bank.schedule_cutoff_unset');
        }
        const cutoffMs = this.options.editCutoffMinutes * 60_000;
        if (row.status === 'active' && row.next_run_at.getTime() - now.getTime() < cutoffMs) {
          throw new BankError(`Too close to the next run at ${row.next_run_at.toISOString()}`, 'bank.schedule_cutoff');
        }

        const cadence = input.cadence ?? row.cadence;
        const endsAt = cadence === 'once' ? null : input.endsAt === undefined ? row.ends_at : input.endsAt;
        if (cadence !== row.cadence) {
          // The anchor stays; occurrence numbers already fired keep their keys. A cadence change re-plans from the
          // highest fired occurrence, so nothing already paid is paid again under the new rhythm.
          const fired = await tx<Array<{ max: number | null }>>`
            SELECT MAX(occurrence) AS max FROM bank.transfer_executions WHERE schedule_id = ${input.scheduleId}
          `;
          if (fired[0]?.max !== null && fired[0]?.max !== undefined) {
            throw new BankError(
              'A schedule that has already run cannot change cadence; cancel it and create a new one',
              'bank.schedule_conflict',
            );
          }
        }
        const plan = planDue({ startsAt: row.starts_at, cadence, endsAt, lastFired: null, now: row.starts_at });
        const nextRunAt = cadence === row.cadence ? row.next_run_at : plan.nextRunAt;

        await tx`
          UPDATE bank.scheduled_transfers
             SET amount = ${input.amount === undefined ? row.amount : formatAmount(input.amount)}::numeric,
                 cadence = ${cadence},
                 ends_at = ${endsAt},
                 reference = COALESCE(${input.reference ?? null}, reference),
                 next_run_at = ${nextRunAt},
                 revision = revision + 1,
                 updated_at = now()
           WHERE id = ${input.scheduleId}
        `;
        await tx`
          INSERT INTO bank.schedule_edits (schedule_id, from_revision, payload_hash)
          VALUES (${input.scheduleId}, ${input.revision}, ${hash})
        `;
        return { scheduleId: input.scheduleId, revision: row.revision + 1, nextRunAt: row.status === 'active' ? nextRunAt : null };
      },
      { isolation: 'read committed', maxAttempts: 5 },
    );
  }
}
