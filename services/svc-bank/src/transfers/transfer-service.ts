import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import { attachTransferMessageTx, bindTransferMessage } from './transfer-message.js';
import { BookedTransferConflict, bookedTransferMatches } from './booked-transfer.js';
import {
  InsufficientFundsError,
  LedgerError,
  bankTransferKey,
  formatAmount,
  parseAmount,
  recipes,
  type Amount,
  type LedgerClient,
} from '@intafaced/ledger-client';
import { BankError } from '../errors.js';
import { assertExecutionsListLimit, assertSchedulesListLimit } from '../owner-list-limit.js';
import { assertTransferDueLimit } from '../job-batch-limit.js';
import { RECIPIENT_CANNOT_RECEIVE_MESSAGE, accountForSpace, type SpaceService } from '../spaces/space-service.js';
import { MAX_CATCH_UP_PER_PASS, dueOccurrence, lastOccurrenceBefore, planDue, occurrenceStart, type ScheduleCadence } from './schedule.js';
import { withMoneySpan, withSpan } from '../tracing.js';

/**
 * TRANSFERS — the rails half of §8.1.
 *
 * Two paths: a one-off transfer a user asks for, and a standing order a
 * scheduler drives. The second is the dangerous one. A scheduler WILL fire
 * twice — a retry, a second replica, a clock stepping backwards over a DST
 * boundary, an operator re-running a job after an outage — so "exactly once"
 * cannot rest on the timer being well behaved.
 *
 * It rests on two independent things instead:
 *
 *   1. `unique(schedule_id, occurrence)` on `bank.transfer_executions`. The job
 *      CLAIMS the occurrence by inserting before it posts. A second run's insert
 *      conflicts and it does nothing.
 *   2. The ledger's idempotency key `bank.transfer.sched:<scheduleId>:<occurrence>`.
 *      Even with the claim bypassed, the second post returns the first one's
 *      transaction rather than moving value again.
 *
 * They agree by construction: both are derived from the same (schedule,
 * occurrence) pair, and `occurrence` is computed from the schedule's anchor and
 * cadence — never from a counter, never from a clock reading.
 */

export interface TransferResult {
  transferId: string;
  occurrence: number;
  ledgerTxId: string;
  amount: string;
}

export interface ScheduleRecord {
  id: string;
  userId: string;
  assetId: string;
  fromSpaceId: string;
  toSpaceId: string;
  amount: Amount;
  cadence: ScheduleCadence;
  startsAt: Date;
  endsAt: Date | null;
  nextRunAt: Date;
  status: 'active' | 'paused' | 'cancelled' | 'completed';
  /** Starts at 1; each edit of the amount or end date adds one, and an edit must name the revision it read. */
  revision: number;
}

interface ScheduleRow {
  id: string;
  user_id: string;
  asset_id: string;
  from_space_id: string;
  to_space_id: string;
  amount: string;
  cadence: ScheduleCadence;
  starts_at: Date;
  ends_at: Date | null;
  next_run_at: Date;
  status: ScheduleRecord['status'];
  revision: number;
}

function toSchedule(row: ScheduleRow): ScheduleRecord {
  return {
    id: row.id,
    userId: row.user_id,
    assetId: row.asset_id,
    fromSpaceId: row.from_space_id,
    toSpaceId: row.to_space_id,
    amount: parseAmount(row.amount),
    cadence: row.cadence,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    nextRunAt: row.next_run_at,
    status: row.status,
    revision: row.revision,
  };
}

/**
 * A same-id retry is the same standing order only when the window matches.
 *
 * `startsAt` anchors every occurrence. `endsAt` is the last instant that may
 * still fire (NULL means until cancelled). An omitted end and a stored NULL
 * are the same instruction — the insert writes NULL for both. A different
 * instant is a different order: accepting it would leave the stored row
 * firing on the first set of dates, or past an end the retry tried to set.
 */
function sameScheduleWindow(storedStartsAt: Date, storedEndsAt: Date | null, startsAt: Date, endsAt: Date | null | undefined): boolean {
  return storedStartsAt.getTime() === startsAt.getTime() && sameEnd(storedEndsAt, endsAt ?? null);
}

function sameEnd(a: Date | null, b: Date | null): boolean {
  return a === null || b === null ? a === b : a.getTime() === b.getTime();
}

/**
 * The owner-set minutes before the next run after which a standing order can no longer be edited. Blank, unset or
 * not a whole number refuses `bank.schedule_edit_cutoff_unset`: no window is invented. Zero is a real owner choice.
 */
export function parseScheduleEditCutoff(raw: string | undefined): number {
  const text = raw?.trim() ?? '';
  if (!/^\d{1,6}$/.test(text)) {
    throw new BankError(
      'Standing order edits are not open: the edit cutoff is not published (BANK_SCHEDULE_EDIT_CUTOFF_MINUTES)',
      'bank.schedule_edit_cutoff_unset',
    );
  }
  return Number(text);
}

export type FiringOutcome = 'settled' | 'rejected' | 'already-fired' | 'stopped' | 'busy';

/**
 * What `rejection_code` says on an occurrence that was skipped.
 *
 * A constant rather than a `BankErrorCode`, because it is not an error and no
 * caller ever receives it as one — it is the reason written into the record so
 * that "nothing happened in March" has an answer a support engineer can read
 * without reconstructing a timeline from `updated_at`. Exported so the tests and
 * any future reporting query name the same string this file writes.
 */
export const PAUSED_SKIP_REASON = 'bank.schedule_paused';

export interface ResumeReport {
  readonly schedule: ScheduleRecord;
  /**
   * Occurrences that came due while paused and will now never fire, ascending.
   *
   * Returned rather than merely recorded because it is the one fact a user must
   * be told when they resume: resuming does NOT settle up. If this list is long,
   * the honest thing for a client to render is "these five payments were not
   * made", not a silent success.
   */
  readonly skipped: readonly number[];
}

export interface RunReport {
  schedulesConsidered: number;
  settled: number;
  rejected: number;
  alreadyFired: number;
  /**
   * Schedules this pass looked at ONLY because they held a stranded claim —
   * they were not otherwise due, and several of them cannot ever be due again.
   *
   * Reported separately because it is the number an operator wants to be zero.
   * A steady non-zero here means processes are dying between claiming an
   * occurrence and posting it, which is invisible in `settled` (the sweep
   * settles them, so the totals look healthy) and invisible in `rejected` (the
   * ledger never refused anything).
   */
  strandedSwept: number;
  /**
   * Schedules that threw mid-drive (network fault, frozen ledger module, …).
   *
   * Those occurrences are NOT consumed — `settle` rethrows so the claim rolls
   * back and the next pass retries. Recording them here is what lets one bad
   * schedule fail loudly without becoming a platform-wide stop: before isolation,
   * the throw escaped `runDueTransfers` and every later schedule on the pass
   * never ran.
   *
   * Isolation alone is not enough under `TRANSFER_BATCH_SIZE`: if the thrower
   * never advances `next_run_at`, N permanently-failing schedules fill the due
   * window forever and healthy schedules behind the limit never get selected.
   * After a failure we bump `next_run_at` to the job's `now` so the poison sorts
   * later than still-older healthy dues on the next pass — retry without starvation.
   */
  failures: Array<{ scheduleId: string; reason: string; code?: string }>;
}

export class TransferService {
  constructor(
    private readonly sql: Sql,
    private readonly ledger: LedgerClient,
    private readonly spaces: SpaceService,
    /** `BANK_SCHEDULE_EDIT_CUTOFF_MINUTES`, read only when an edit is asked for. */
    private readonly scheduleTerms: { readonly editCutoffMinutes?: string } = {},
  ) {}

  // ── One-off transfer ───────────────────────────────────────────────────────

  /**
   * Move value between two spaces, now.
   *
   * `transferId` is supplied by the caller (a client-generated request id) so a
   * retried HTTP request is the same transfer, not a second one. Occurrence is
   * 0: a one-off transfer is a schedule that fires once.
   *
   * If this crashes exactly here — after the ledger post, before returning —
   * nobody's funds are stranded. The movement is committed in the book and the
   * caller's retry with the same `transferId` returns the original transaction.
   * There is no local row for this path precisely so there is nothing to
   * disagree with the ledger about.
   */
  async transfer(input: {
    transferId: string;
    fromSpaceId: string;
    toSpaceId: string;
    amount: Amount;
    note?: string | null;
    reference?: string | null;
    /**
     * Whose id `transferId` is. A user moving value between their own spaces is `own` (the default);
     * a payment to another user is `p2p`. The two never share an idempotency key, so a caller that
     * hands both the same id books two transfers instead of being told the first one is the second.
     */
    keySpace?: 'own' | 'p2p';
    now?: Date;
  }): Promise<TransferResult> {
    const now = input.now ?? new Date();
    const keySpace = input.keySpace ?? 'own';

    return withMoneySpan(
      'bank.transfer',
      { operation: 'transfer', amount: formatAmount(input.amount), spaceId: input.fromSpaceId },
      async () => {
        if (input.fromSpaceId === input.toSpaceId) {
          throw new BankError('A transfer needs two different spaces', 'bank.same_space');
        }

        const from = await this.spaces.resolveForDebit(input.fromSpaceId, now);
        const to = await this.spaces.resolveForCredit(input.toSpaceId, {
          actingUserId: from.userId,
          alreadyBooked: async () => (await this.ledger.getTxByKey(bankTransferKey(keySpace, input.transferId, 0))) !== null,
        });

        if (from.assetId !== to.assetId) {
          // Converting between assets is a trade, and a trade has an execution
          // price this service has no business inventing (§4.2: svc-trade prices).
          throw new BankError(`Cannot transfer ${from.assetId} into a ${to.assetId} space — convert first`, 'bank.asset_mismatch');
        }

        const note = input.note ?? null;
        const reference = input.reference ?? null;
        await bindTransferMessage(this.sql, this.ledger, {
          transferId: input.transferId,
          keySpace,
          fromUserId: from.userId,
          toUserId: to.userId,
          note,
          reference,
        });

        const fromAccount = accountForSpace(from);
        const toAccount = accountForSpace(to);
        const tx = await this.ledger.post(
          recipes.bankTransfer({
            transferId: input.transferId,
            occurrence: 0,
            from: fromAccount,
            to: toAccount,
            amount: input.amount,
            kind: 'manual',
            keySpace,
          }),
        );
        // A ledger in `detect` mode answers a reused key with the ORIGINAL transaction. Never report this send as
        // booked, or echo its amount, unless the transaction we were handed is this movement.
        if (!(await bookedTransferMatches(this.ledger, tx, fromAccount, toAccount, input.amount))) {
          throw new BookedTransferConflict(input.transferId);
        }

        if (note !== null || reference !== null) await attachTransferMessageTx(this.sql, input.transferId, tx.id);

        return { transferId: input.transferId, occurrence: 0, ledgerTxId: tx.id, amount: formatAmount(input.amount) };
      },
    );
  }

  async transferToUser(input: {
    transferId: string;
    fromSpaceId: string;
    toUserId: string;
    amount: Amount;
    now?: Date;
  }): Promise<TransferResult> {
    const now = input.now ?? new Date();
    return withMoneySpan(
      'bank.transferToUser',
      { operation: 'transfer', amount: formatAmount(input.amount), spaceId: input.fromSpaceId },
      async () => {
        const destUserId = input.toUserId.trim();
        const from = await this.spaces.resolveForDebit(input.fromSpaceId, now);
        const dest = destUserId ? await this.spaces.primaryForCredit(destUserId, from.assetId) : null;
        if (!dest) {
          // One code and one message for "no such account", frozen and closed:
          // the caller must not be able to tell them apart.
          throw new BankError(RECIPIENT_CANNOT_RECEIVE_MESSAGE, 'bank.recipient_cannot_receive');
        }
        return this.transfer({
          transferId: input.transferId,
          fromSpaceId: input.fromSpaceId,
          toSpaceId: dest.id,
          amount: input.amount,
          keySpace: 'p2p',
          now,
        });
      },
    );
  }

  // ── Standing orders ────────────────────────────────────────────────────────

  async scheduleToUser(input: {
    userId: string;
    fromSpaceId: string;
    toUserId: string;
    amount: Amount;
    cadence: ScheduleCadence;
    startsAt: Date;
    endsAt?: Date | null;
    scheduleId: string;
  }): Promise<ScheduleRecord> {
    const destUserId = input.toUserId.trim();
    const from = await this.spaces.get(input.fromSpaceId);
    const dest = destUserId ? await this.spaces.primaryForCredit(destUserId, from.assetId) : null;
    if (!dest) {
      // Same one code as frozen and closed, so a far-future schedule is not a
      // free way to learn that an id is frozen.
      throw new BankError(RECIPIENT_CANNOT_RECEIVE_MESSAGE, 'bank.recipient_cannot_receive');
    }
    return this.schedule({
      userId: input.userId,
      fromSpaceId: input.fromSpaceId,
      toSpaceId: dest.id,
      amount: input.amount,
      cadence: input.cadence,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      scheduleId: input.scheduleId,
    });
  }

  async schedule(input: {
    userId: string;
    fromSpaceId: string;
    toSpaceId: string;
    amount: Amount;
    cadence: ScheduleCadence;
    startsAt: Date;
    endsAt?: Date | null;
    scheduleId: string;
  }): Promise<ScheduleRecord> {
    if (!input.scheduleId) {
      throw new BankError('Standing order create needs a caller-stable schedule id', 'bank.schedule_id_required');
    }
    if (input.fromSpaceId === input.toSpaceId) {
      throw new BankError('A standing order needs two different spaces', 'bank.same_space');
    }
    if (input.cadence === 'once' && input.endsAt) {
      // A one-off has one date. An end date on it would be a second, unused instruction a retry has to match.
      throw new BankError('A one-off payment has a date and no end date', 'bank.validation_failed');
    }

    const from = await this.spaces.get(input.fromSpaceId);
    const to = await this.spaces.get(input.toSpaceId);
    if (from.assetId !== to.assetId) {
      throw new BankError(`Cannot schedule ${from.assetId} into a ${to.assetId} space`, 'bank.asset_mismatch');
    }
    // Refuse a standing order to a recipient who cannot receive, at creation
    // as well as at each run: it is the earliest place the user can be told.
    if (to.userId !== from.userId) await this.spaces.assertCanReceive(to.userId);

    const scheduleId = input.scheduleId;

    const rows = await this.sql<ScheduleRow[]>`
      INSERT INTO bank.scheduled_transfers
        (id, user_id, asset_id, from_space_id, to_space_id, amount, cadence, starts_at, ends_at, next_run_at)
      VALUES (
        ${scheduleId}::uuid, ${input.userId}, ${from.assetId}, ${input.fromSpaceId}, ${input.toSpaceId},
        ${formatAmount(input.amount)}::numeric, ${input.cadence}, ${input.startsAt},
        ${input.endsAt ?? null}, ${input.startsAt}
      )
      ON CONFLICT (id) DO NOTHING
      RETURNING id, user_id, asset_id, from_space_id, to_space_id, amount, cadence,
                starts_at, ends_at, next_run_at, status, revision
    `;
    if (rows.length > 0) return toSchedule(rows[0]!);

    const existing = await this.sql<ScheduleRow[]>`
      SELECT id, user_id, asset_id, from_space_id, to_space_id, amount, cadence,
             starts_at, ends_at, next_run_at, status, revision
        FROM bank.scheduled_transfers WHERE id = ${scheduleId}
    `;
    const row = existing[0];
    if (!row) throw new BankError(`Schedule ${scheduleId} disappeared after a conflict`, 'bank.schedule_not_found');
    // An edited order is compared on the terms it was created with: a retry of the create carries those, not the edit's.
    const original =
      row.revision > 1
        ? (
            await this.sql<Array<{ amount: string; ends_at: Date | null }>>`
              SELECT amount, ends_at FROM bank.schedule_revisions WHERE schedule_id = ${scheduleId} AND revision = 1
            `
          )[0]
        : { amount: row.amount, ends_at: row.ends_at };
    if (
      !original ||
      row.user_id !== input.userId ||
      row.from_space_id !== input.fromSpaceId ||
      row.to_space_id !== input.toSpaceId ||
      parseAmount(original.amount) !== input.amount ||
      row.cadence !== input.cadence ||
      !sameScheduleWindow(row.starts_at, original.ends_at, input.startsAt, input.endsAt)
    ) {
      throw new BankError(
        `Schedule ${scheduleId} already exists on different terms — a retry must carry the same instruction`,
        'bank.schedule_conflict',
      );
    }
    return toSchedule(row);
  }

  /**
   * One standing order, by id, WITHOUT filtering on a user.
   *
   * Deliberately unfiltered: the caller is the router, and what it needs is the
   * owner so it can decide. A `getSchedule(scheduleId, userId)` that quietly
   * returned nothing for someone else's row would fold "does not exist" and
   * "is not yours" into one answer here, where only the router knows which of
   * those the caller should be told.
   */
  async getSchedule(scheduleId: string): Promise<ScheduleRecord> {
    const rows = await this.sql<ScheduleRow[]>`
      SELECT id, user_id, asset_id, from_space_id, to_space_id, amount, cadence,
             starts_at, ends_at, next_run_at, status, revision
        FROM bank.scheduled_transfers WHERE id = ${scheduleId}
    `;
    const row = rows[0];
    if (!row) throw new BankError(`Schedule ${scheduleId} not found`, 'bank.schedule_not_found');
    return toSchedule(row);
  }

  async listSchedules(userId: string, limit?: number): Promise<ScheduleRecord[]> {
    const page = assertSchedulesListLimit(limit);
    const rows = await this.sql<ScheduleRow[]>`
      SELECT id, user_id, asset_id, from_space_id, to_space_id, amount, cadence,
             starts_at, ends_at, next_run_at, status, revision
        FROM bank.scheduled_transfers WHERE user_id = ${userId} ORDER BY created_at DESC
       LIMIT ${page}
    `;
    return rows.map(toSchedule);
  }

  /**
   * Change a standing order's amount or end date (BK-xfer-10). The recipient, the spaces, the cadence and the start stay
   * as they were: occurrence N is defined by `(startsAt, cadence, N)`, so changing either would re-number the
   * occurrences already run and the business keys they posted under.
   *
   * The caller names the revision it read. The update is one statement guarded by that revision, so of two edits sent
   * at the same revision exactly one lands; the other refuses `bank.schedule_revision_conflict` and changes nothing. The
   * same edit sent again (a retry of one that landed) reads back the revision it made and is answered with it.
   *
   * No edit of an active order inside the owner-set cutoff before its next run (`bank.schedule_cutoff`), and none at all
   * while the cutoff is not published (`bank.schedule_edit_cutoff_unset`). A paused order has no run coming, so the
   * cutoff does not apply to it. An end at or before the next run closes the window, and the order is completed. A run takes the row lock and claims with the amount it finds
   * under it, so a run and an edit are ordered by that lock: the run uses the instruction as it stood, never half of it.
   *
   * What the order said before each edit is kept in `bank.schedule_revisions`, so what the person authorised survives.
   * Nothing is posted here. If this crashes exactly here, whose funds are stranded? No one's: the edit and its history
   * row commit together or not at all, and no value moves.
   */
  async updateSchedule(input: {
    scheduleId: string;
    userId: string;
    revision: number;
    amount: Amount;
    endsAt: Date | null;
    now?: Date;
  }): Promise<ScheduleRecord> {
    const now = input.now ?? new Date();
    const cutoffMinutes = parseScheduleEditCutoff(this.scheduleTerms.editCutoffMinutes);
    if (input.amount <= 0n) throw new BankError('A standing order amount must be above zero', 'bank.validation_failed');
    return transaction(
      this.sql,
      async (tx) => {
        const rows = await tx<ScheduleRow[]>`
          SELECT id, user_id, asset_id, from_space_id, to_space_id, amount, cadence,
                 starts_at, ends_at, next_run_at, status, revision
            FROM bank.scheduled_transfers WHERE id = ${input.scheduleId} FOR UPDATE
        `;
        const row = rows[0];
        if (!row || row.user_id !== input.userId) {
          throw new BankError(`Schedule ${input.scheduleId} not found`, 'bank.schedule_not_found');
        }
        const current = toSchedule(row);
        // A retry of the edit that made this revision: same values, one revision on. Answered, not refused.
        if (current.revision === input.revision + 1 && current.amount === input.amount && sameEnd(current.endsAt, input.endsAt)) {
          return current;
        }
        if (current.revision !== input.revision) {
          throw new BankError(
            `Schedule ${input.scheduleId} is at revision ${current.revision}, not ${input.revision}: read it again before editing`,
            'bank.schedule_revision_conflict',
          );
        }
        if (current.status !== 'active' && current.status !== 'paused') {
          throw new BankError(`Schedule ${input.scheduleId} is ${current.status} and cannot be edited`, 'bank.schedule_inactive');
        }
        if (current.cadence === 'once' && input.endsAt !== null) {
          throw new BankError('A one-off payment has a date and no end date', 'bank.validation_failed');
        }
        if (input.endsAt !== null && input.endsAt.getTime() <= Math.max(now.getTime(), current.startsAt.getTime())) {
          throw new BankError('The end date must be after today and after the first payment', 'bank.validation_failed');
        }
        if (current.status === 'active' && current.nextRunAt.getTime() - now.getTime() < cutoffMinutes * 60_000) {
          throw new BankError(
            `The next payment is due ${current.nextRunAt.toISOString()}; edits close ${cutoffMinutes} minutes before it`,
            'bank.schedule_cutoff',
          );
        }
        await tx`
          INSERT INTO bank.schedule_revisions (schedule_id, revision, amount, ends_at, replaced_by)
          VALUES (${current.id}, ${current.revision}, ${formatAmount(current.amount)}::numeric, ${current.endsAt}, ${input.userId})
        `;
        // `next_run_at` is the next occurrence not yet run, and the end is exclusive: an end at or before it leaves none.
        const closes = input.endsAt !== null && input.endsAt.getTime() <= current.nextRunAt.getTime();
        const updated = await tx<ScheduleRow[]>`
          UPDATE bank.scheduled_transfers
             SET amount = ${formatAmount(input.amount)}::numeric, ends_at = ${input.endsAt},
                 status = ${closes ? 'completed' : current.status},
                 revision = revision + 1, updated_at = now()
           WHERE id = ${current.id} AND revision = ${current.revision}
           RETURNING id, user_id, asset_id, from_space_id, to_space_id, amount, cadence,
                     starts_at, ends_at, next_run_at, status, revision
        `;
        return toSchedule(updated[0]!);
      },
      { isolation: 'read committed', maxAttempts: 5 },
    );
  }

  /** Earlier revisions of one standing order, newest first: what it said before each edit. */
  async scheduleRevisions(scheduleId: string): Promise<Array<{ revision: number; amount: Amount; endsAt: Date | null; replacedAt: Date }>> {
    const rows = await this.sql<Array<{ revision: number; amount: string; ends_at: Date | null; replaced_at: Date }>>`
      SELECT revision, amount, ends_at, replaced_at FROM bank.schedule_revisions
       WHERE schedule_id = ${scheduleId} ORDER BY revision DESC LIMIT 100
    `;
    return rows.map((r) => ({ revision: r.revision, amount: parseAmount(r.amount), endsAt: r.ends_at, replacedAt: r.replaced_at }));
  }

  /**
   * Cancel a standing order.
   *
   * Cancelling never touches occurrences that have already fired: those are
   * completed movements in the ledger, and "cancel" is not "reverse". A reversal
   * would need its own recipe, its own authorisation, and the counterparty's
   * consent — none of which a cancel button implies.
   */
  async cancelSchedule(scheduleId: string): Promise<void> {
    const updated = await this.sql`
      UPDATE bank.scheduled_transfers SET status = 'cancelled', updated_at = now()
       WHERE id = ${scheduleId} AND status IN ('active', 'paused')
       RETURNING id
    `;
    if (updated.length === 0) throw new BankError(`Schedule ${scheduleId} is not cancellable`, 'bank.schedule_inactive');
  }

  // ── Pause and resume ───────────────────────────────────────────────────────

  /**
   * Stop a standing order firing, without destroying it.
   *
   * Cancel was the only way to stop one, and cancel is not reversible: a user
   * between jobs who wanted to hold their rent transfer for two months had to
   * cancel and later create a new schedule. That is worse than clumsy, it is
   * UNSAFE — the new schedule has a NEW id, and the ledger's idempotency key is
   * `bank.transfer.sched:<scheduleId>:<occurrence>`. Occurrence 0 of the replacement
   * shares no key with occurrence 3 of the original, so a replacement anchored a
   * few days early moves value on a date the original would also have moved it
   * and nothing anywhere collapses the two. Pause keeps the id, which keeps the
   * key, which keeps the guarantee.
   *
   * `paused` has been in `bank.schedule_status` since 0000 and until now no code
   * path wrote it. `cancelSchedule` has always accepted `IN ('active','paused')`
   * — that branch was unreachable and is now the ordinary way a paused order is
   * given up on.
   *
   * NOT a money span: pausing posts nothing and decides nothing. It sets a flag
   * that stops the runner selecting this row (`WHERE status = 'active'`), and it
   * is completely reversible until `resumeSchedule` turns the elapsed time into
   * a record. That call is the one the sampler must keep.
   */
  async pauseSchedule(scheduleId: string): Promise<ScheduleRecord> {
    return withSpan('bank.transfer.pause', async () => {
      const rows = await this.sql<ScheduleRow[]>`
        UPDATE bank.scheduled_transfers SET status = 'paused', updated_at = now()
         WHERE id = ${scheduleId} AND status = 'active'
         RETURNING id, user_id, asset_id, from_space_id, to_space_id, amount, cadence,
                   starts_at, ends_at, next_run_at, status, revision
      `;

      const row = rows[0];
      if (row) return toSchedule(row);

      // Nothing updated: either there is no such schedule, or it is not active.
      // `getSchedule` throws `bank.schedule_not_found` for the first, which is a
      // different fact from the second and must not be flattened into it.
      await this.getSchedule(scheduleId);
      throw new BankError(`Schedule ${scheduleId} is not active`, 'bank.schedule_inactive');
    });
  }

  /**
   * Start a paused standing order again — from HERE, never from where it stopped.
   *
   * THE WHOLE DESIGN IS IN WHAT RESUME DOES *NOT* DO.
   *
   * `planDue` fires every occurrence between `lastFired` and `now`. That is
   * exactly right after an outage — the transfers were due, the runner was down,
   * the user still expects them. It is exactly wrong after a pause: the user
   * stopped the order precisely so those transfers would not happen, and a
   * resume that "caught up" would move three months of rent in one pass, on a
   * day nobody chose, out of a space that may not hold it.
   *
   * So resume RECORDS the elapsed occurrences as `skipped` before it lifts the
   * pause. That is not bookkeeping garnish — `MAX(occurrence)` over
   * `bank.transfer_executions` IS `lastFired`, so writing the rows is what moves
   * the schedule's floor forward, and the same unique index that makes a
   * double-fire impossible makes a double-skip impossible. There is no second
   * mechanism, no `resumed_at` watermark to keep in step with the executions
   * table, and nothing that could disagree with it.
   *
   * The occurrence due at the instant of resume is skipped too. "Resume" means
   * the next scheduled movement, not this one: a rule a user can predict beats a
   * rule that depends on whether they clicked before or after 09:00.
   *
   * Two consequences worth stating plainly:
   *
   *   · resuming moves no value, ever. It posts nothing to the ledger.
   *   · an occurrence CLAIMED before the pause (a `pending` row, a process that
   *     died between claim and post) is protected by `ON CONFLICT DO NOTHING`
   *     and stays pending, so the runner's stranded sweep still completes it.
   *     A claim is a commitment already made; a pause cannot retract it.
   */
  async resumeSchedule(scheduleId: string, options: { now?: Date; maxCatchUp?: number } = {}): Promise<ResumeReport> {
    const now = options.now ?? new Date();

    return withMoneySpan('bank.transfer.resume', { operation: 'resume-standing-order', scheduleId }, async (span) => {
      const report = await transaction(
        this.sql,
        async (tx) => {
          // FOR UPDATE, because two resumes racing would otherwise both read the
          // same `lastFired` and both plan the same skip window. The insert is
          // idempotent, so the damage would be limited to a confusing report —
          // but "limited to" is not a property to rely on in a money service.
          const locked = await tx<ScheduleRow[]>`
            SELECT id, user_id, asset_id, from_space_id, to_space_id, amount, cadence,
                   starts_at, ends_at, next_run_at, status, revision
              FROM bank.scheduled_transfers WHERE id = ${scheduleId} FOR UPDATE
          `;
          const row = locked[0];
          if (!row) throw new BankError(`Schedule ${scheduleId} not found`, 'bank.schedule_not_found');

          const schedule = toSchedule(row);
          if (schedule.status !== 'paused') {
            throw new BankError(`Schedule ${scheduleId} is not paused`, 'bank.schedule_inactive');
          }

          const fired = await tx<Array<{ last: number | null }>>`
            SELECT MAX(occurrence) AS last FROM bank.transfer_executions WHERE schedule_id = ${scheduleId}
          `;
          const lastFired = fired[0]?.last ?? null;

          // The window to write off: everything due at `now`, bounded by the
          // schedule's own end. An occurrence past `endsAt` was never going to
          // fire, so it is not "skipped" — it does not exist, and inventing a row
          // for it would misreport the order as having missed payments it never
          // owed.
          const due = dueOccurrence(schedule.startsAt, schedule.cadence, now);
          const windowEnd = lastOccurrenceBefore(schedule.startsAt, schedule.cadence, schedule.endsAt);
          const ceiling = due === null ? null : windowEnd === null ? due : Math.min(due, windowEnd);
          const from = lastFired === null ? 0 : lastFired + 1;

          let skipped: number[] = [];
          if (ceiling !== null && from <= ceiling) {
            // One statement for the whole window. Unbounded on purpose: the
            // record has to be COMPLETE, because an occurrence with no row is an
            // occurrence the next pass fires. `MAX_CATCH_UP_PER_PASS` bounds how
            // many transfers may be POSTED in a pass, which is a rate limit on
            // moving money; there is no equivalent reason to rate-limit a write
            // that guarantees money is not moved.
            const claimed = await tx<Array<{ occurrence: number }>>`
              INSERT INTO bank.transfer_executions (schedule_id, occurrence, amount, status, rejection_code)
              SELECT ${scheduleId}, n, ${formatAmount(schedule.amount)}::numeric, 'skipped', ${PAUSED_SKIP_REASON}
                FROM generate_series(${from}::int, ${ceiling}::int) AS n
              ON CONFLICT (schedule_id, occurrence) DO NOTHING
              RETURNING occurrence
            `;
            skipped = claimed.map((r) => r.occurrence).sort((a, b) => a - b);
          }

          // Re-plan with the floor the skip rows just established, using the SAME
          // arithmetic the runner uses. Deriving `next_run_at` by hand here is
          // how the two would drift.
          const newLastFired = ceiling === null ? lastFired : Math.max(lastFired ?? ceiling, ceiling);
          const plan = planDue({
            startsAt: schedule.startsAt,
            cadence: schedule.cadence,
            endsAt: schedule.endsAt,
            lastFired: newLastFired,
            now,
            maxCatchUp: options.maxCatchUp,
          });

          // THE INVARIANT THIS METHOD EXISTS FOR. Nothing may be due the moment a
          // schedule resumes; if anything is, the skip window and the runner's
          // plan disagree and the next pass would fire the backlog this call was
          // written to prevent. Refusing rolls the whole transaction back, which
          // leaves the order paused — the safe side of the failure.
          if (plan.occurrences.length > 0) {
            throw new Error(
              `resume would leave ${plan.occurrences.length} occurrence(s) immediately due on schedule ${scheduleId} — refusing`,
            );
          }

          const updated = await tx<ScheduleRow[]>`
            UPDATE bank.scheduled_transfers
               SET status = ${plan.completed ? 'completed' : 'active'},
                   next_run_at = ${plan.nextRunAt},
                   updated_at = now()
             WHERE id = ${scheduleId} AND status = 'paused'
             RETURNING id, user_id, asset_id, from_space_id, to_space_id, amount, cadence,
                       starts_at, ends_at, next_run_at, status, revision
          `;

          return { schedule: toSchedule(updated[0]!), skipped };
        },
        { isolation: 'read committed', maxAttempts: 5 },
      );

      span.setAttribute('intafaced.skipped_occurrences', report.skipped.length);
      span.setAttribute('intafaced.outcome', report.schedule.status);
      return report;
    });
  }

  // ── The runner ─────────────────────────────────────────────────────────────

  /**
   * Fire every standing order that is due, and finish every claim that was left
   * behind.
   *
   * Safe to run twice, concurrently, or after an outage. The claim row and the
   * ledger key both key on (schedule, occurrence), so the second run finds every
   * occurrence already taken and does nothing.
   *
   * TWO QUERIES, AND THE SECOND ONE IS THE IMPORTANT ONE.
   *
   * A `pending` row is an occurrence this service CLAIMED and never posted — a
   * process that died between the two. Sweeping it used to be a side effect of
   * the schedule being due again, which was true enough while every schedule was
   * either active or dead: tomorrow's pass would pick the row up.
   *
   * `pause` broke that, and it broke it silently. A paused schedule is never
   * selected by the due query, so a claim stranded before the pause would sit
   * there for as long as the user left the order paused — forever, if they never
   * resumed it — with no error raised anywhere and no way for the user to see
   * that a transfer they authorised had been half-performed. `resume` makes it
   * worse rather than better: it moves `next_run_at` PAST the stranded
   * occurrence, so even resuming does not bring the sweep back.
   *
   * So a stranded claim is now a reason to look at a schedule in its own right,
   * independent of `next_run_at` and independent of `status`. That last part is
   * deliberate: cancelling does not retract a claim either. Cancel stops FUTURE
   * firings and is explicitly not a reversal — an occurrence already claimed is
   * a movement this service committed to, and the honest completion of it is to
   * post it, not to leave a `pending` row nobody will ever explain.
   *
   * Sweeping never plans new occurrences and never advances `next_run_at`. It
   * finishes what was started and touches nothing else.
   */
  async runDueTransfers(options: { now?: Date; limit?: number; maxCatchUp?: number } = {}): Promise<RunReport> {
    const now = options.now ?? new Date();
    const limit = assertTransferDueLimit(options.limit);

    const due = await this.sql<ScheduleRow[]>`
      SELECT id, user_id, asset_id, from_space_id, to_space_id, amount, cadence,
             starts_at, ends_at, next_run_at, status, revision
        FROM bank.scheduled_transfers
       WHERE status = 'active' AND next_run_at <= ${now}
       ORDER BY next_run_at ASC
       LIMIT ${limit}
    `;

    // Excluded rather than merged, so a schedule that is BOTH due and stranded
    // is driven once — `driveSchedule` sweeps its own stranded claims first,
    // and doing it twice would double-count the outcomes in the report.
    const dueIds = due.map((row) => row.id);
    const stranded = await this.sql<ScheduleRow[]>`
      SELECT s.id, s.user_id, s.asset_id, s.from_space_id, s.to_space_id, s.amount, s.cadence,
             s.starts_at, s.ends_at, s.next_run_at, s.status, s.revision
        FROM bank.scheduled_transfers s
       WHERE NOT (s.id = ANY(${dueIds}::uuid[]))
         AND EXISTS (
           SELECT 1 FROM bank.transfer_executions e
            WHERE e.schedule_id = s.id AND e.status = 'pending'
         )
       ORDER BY s.created_at ASC
       LIMIT ${limit}
    `;

    const report: RunReport = {
      schedulesConsidered: due.length + stranded.length,
      settled: 0,
      rejected: 0,
      alreadyFired: 0,
      strandedSwept: stranded.length,
      failures: [],
    };

    const count = (outcomes: FiringOutcome[]) => {
      for (const outcome of outcomes) {
        if (outcome === 'settled') report.settled++;
        else if (outcome === 'rejected') report.rejected++;
        else if (outcome === 'already-fired') report.alreadyFired++;
        // 'stopped' — cancel/pause mid-drive; no counter, no claim.
        // 'busy' — another pass holds this schedule; no counter, no claim.
      }
    };

    const recordFailure = (scheduleId: string, err: unknown) => {
      // One schedule's fault must not halt every other standing order on the
      // platform. Same posture as `runRiskSweep`: report and continue. The
      // occurrence itself is still un-consumed (rethrow inside settle rolls the
      // claim back), so the next pass retries this one alone.
      const reason = err instanceof Error ? err.message : String(err);
      const code = err instanceof BankError || err instanceof LedgerError ? err.code : undefined;
      report.failures.push({ scheduleId, reason, ...(code ? { code } : {}) });
    };

    /**
     * Deprioritise a thrower so it cannot permanently occupy the oldest
     * `next_run_at` slots under `LIMIT`. Setting to the job's `now` keeps the
     * schedule due (still ≤ now on the next tick) but sorts it after any
     * healthy schedule whose watermark is still older. Stranded claims are
     * selected by a separate query and are not affected.
     */
    const deprioritiseAfterFailure = async (scheduleId: string) => {
      await this.sql`
        UPDATE bank.scheduled_transfers
           SET next_run_at = ${now}, updated_at = now()
         WHERE id = ${scheduleId} AND status = 'active'
      `;
    };

    for (const row of due) {
      try {
        count(await this.driveSchedule(toSchedule(row), now, options.maxCatchUp ?? MAX_CATCH_UP_PER_PASS));
      } catch (err) {
        recordFailure(row.id, err);
        await deprioritiseAfterFailure(row.id);
      }
    }
    for (const row of stranded) {
      try {
        count(await this.sweepStrandedClaims(toSchedule(row), now));
      } catch (err) {
        recordFailure(row.id, err);
        // Stranded rows are not ordered by next_run_at in the due window; still
        // bump so a permanently-failing stranded schedule cannot re-enter the
        // due set forever as the oldest active watermark if it later becomes due.
        await deprioritiseAfterFailure(row.id);
      }
    }

    return report;
  }

  /**
   * Finish the occurrences that were claimed and never posted.
   *
   * Re-driving is strictly safe: the ledger post is idempotent on
   * `bank.transfer.sched:<scheduleId>:<occurrence>`, so a claim whose post DID land
   * before the process died finds the original transaction rather than moving
   * value a second time.
   */
  private async sweepStrandedClaims(schedule: ScheduleRecord, now: Date = new Date()): Promise<FiringOutcome[]> {
    const stranded = await this.sql<Array<{ occurrence: number }>>`
      SELECT occurrence FROM bank.transfer_executions
       WHERE schedule_id = ${schedule.id} AND status = 'pending'
       ORDER BY occurrence ASC
    `;

    const outcomes: FiringOutcome[] = [];
    for (const row of stranded) {
      outcomes.push(await this.fireOccurrence(schedule, row.occurrence, now));
    }
    return outcomes;
  }

  private async driveSchedule(schedule: ScheduleRecord, now: Date, maxCatchUp: number): Promise<FiringOutcome[]> {
    // What has ALREADY happened, from the record of firings — never from a
    // counter on the schedule row. A counter that a retry double-increments
    // skips a user's transfer silently; this cannot.
    const fired = await this.sql<Array<{ last: number | null }>>`
      SELECT MAX(occurrence) AS last FROM bank.transfer_executions WHERE schedule_id = ${schedule.id}
    `;

    const plan = planDue({
      startsAt: schedule.startsAt,
      cadence: schedule.cadence,
      endsAt: schedule.endsAt,
      lastFired: fired[0]?.last ?? null,
      now,
      maxCatchUp,
    });

    // Claims that were never finished go FIRST, in occurrence order, so a
    // statement reads in the order the user's transfers were meant to happen.
    // `sweepStrandedClaims` is the same code the standalone sweep uses — one
    // definition of "finish what was started", not two that could drift.
    // Stranded claims still finish even if the schedule was cancelled/paused
    // after the claim — cancel is not a reversal of a committed movement.
    const outcomes: FiringOutcome[] = await this.sweepStrandedClaims(schedule, now);
    for (const occurrence of plan.occurrences) {
      const outcome = await this.fireOccurrence(schedule, occurrence, now);
      // Cancel/pause after this pass selected the schedule: stop planning new
      // claims. Pending claims already swept above.
      if (outcome === 'stopped') break;
      outcomes.push(outcome);
      // Another pass owns this schedule right now. Do not plan past it.
      if (outcome === 'busy') break;
    }

    // A busy firing is not an owned occurrence: the pass holding it can still
    // roll back, and moving the watermark past it would push the retry out by a
    // whole period. Leave the hint for the pass that owns the lock (or the next).
    if (outcomes.includes('busy')) return outcomes;

    // Advance the scheduling hint LAST. If this update is lost, the next pass
    // reconsiders occurrences that the executions table already owns and skips
    // them — wasted work, never a double transfer. The other order would let a
    // crash advance past an occurrence that never fired.
    //
    // `status = 'active'` in the WHERE means a concurrent cancel/pause leaves
    // the watermark alone — correct: we did not finish the planned window.
    await this.sql`
      UPDATE bank.scheduled_transfers
         SET next_run_at = ${plan.nextRunAt},
             status = ${plan.completed ? 'completed' : schedule.status},
             updated_at = now()
       WHERE id = ${schedule.id} AND status = 'active'
    `;

    return outcomes;
  }

  /**
   * One firing of one standing order.
   *
   * Ordering, and what a crash at each point costs:
   *
   *   claim row → ledger post → mark settled, all in one database transaction.
   *
   *   · crash before the claim commits  — nothing happened; next pass retries.
   *   · crash after the ledger post, before the commit — the database rolls the
   *     claim back while the ledger transaction stands. The next pass re-claims
   *     and re-posts; the post is idempotent on
   *     `bank.transfer.sched:<schedule>:<occurrence>` so it returns the SAME
   *     transaction and the row is written against it. Money moved once, the
   *     record catches up. Nobody's funds are stranded — the value is in the
   *     destination account the whole time, and the only thing that was ever
   *     missing was our note about it.
   *   · crash after the commit — done.
   *
   * Holding a database transaction open across the ledger call is a deliberate
   * cost: it is what makes "claimed" and "posted" inseparable. The alternative,
   * committing the claim first, creates a window where a claimed occurrence has
   * no ledger transaction and no process left alive to make one — a transfer the
   * user was told would happen, that never will.
   */
  private async fireOccurrence(schedule: ScheduleRecord, occurrence: number, now: Date = new Date()): Promise<FiringOutcome> {
    return withMoneySpan(
      'bank.transfer.scheduled',
      {
        operation: 'scheduled-transfer',
        scheduleId: schedule.id,
        occurrence,
        amount: formatAmount(schedule.amount),
        assetId: schedule.assetId,
      },
      async (span) => {
        const outcome = await this.fireOccurrenceInner(schedule, occurrence, now);
        span.setAttribute('intafaced.outcome', outcome);
        return outcome;
      },
    );
  }

  private async fireOccurrenceInner(schedule: ScheduleRecord, occurrence: number, now: Date): Promise<FiringOutcome> {
    // Same product gates as a one-off transfer. A self-imposed lock or archive
    // must stop the standing order too — bare `get` used to bypass them and
    // drain a space the user had locked for rent.
    //
    // Resolve *inside* the claim transaction path so a locked debit still
    // consumes the occurrence (reject + reason), matching insufficient funds:
    // a locked March is a March transfer that did not run, not an infinite
    // retry storm while the lock holds. Lock clock is the job's `now`, same as
    // the due planner — not a separate wall-clock reading.
    return transaction(
      this.sql,
      async (tx) => {
        // Re-check schedule status under the same transaction as the claim.
        // The due query freezes `status=active` at pass start; without this,
        // a concurrent cancel/pause still lets every remaining planned
        // occurrence claim and settle inside this drive.
        //
        // SKIP LOCKED, not wait. This row lock is held across the ledger post, so
        // a second pass that queued on it would sit on a pool connection for that
        // whole call, and enough overlapping passes would leave nothing for the
        // rest of the service. A locked row is a pass that is already driving this
        // schedule (or a pause / cancel / resume mid-write): nothing is claimed
        // here, no value moves, and the next pass picks the occurrence up again if
        // it is still owed. `driveSchedule` reads `busy` as "do not advance the
        // watermark": the pass that owns the lock may still roll back.
        //
        // The amount comes from under the same lock. An edit (`updateSchedule`) takes this row lock too, so a claim made
        // here carries the instruction as it stands now, not as it stood when the pass selected the schedule.
        const live = await tx<Array<{ status: string; amount: string }>>`
          SELECT status, amount FROM bank.scheduled_transfers WHERE id = ${schedule.id} FOR UPDATE SKIP LOCKED
        `;
        if (live.length === 0) return 'busy' as const;
        const isActive = live[0]?.status === 'active';

        let executionId: string;
        // What this occurrence posts: the amount on its claim row, which is what the person reads in the run history.
        let claimAmount: Amount;
        if (isActive) {
          claimAmount = parseAmount(live[0]!.amount);
          const claimed = await tx<Array<{ id: string }>>`
            INSERT INTO bank.transfer_executions (schedule_id, occurrence, amount, status)
            VALUES (${schedule.id}, ${occurrence}, ${formatAmount(claimAmount)}::numeric, 'pending')
            ON CONFLICT (schedule_id, occurrence) DO NOTHING
            RETURNING id
          `;

          if (claimed.length === 0) {
            // Another pass owns this occurrence. Almost always it is finished; a
            // row still `pending` means a process died in a way that committed the
            // claim without the post, so re-drive it — the ledger post is
            // idempotent, which makes re-driving strictly safe.
            const existing = await tx<Array<{ id: string; status: string; amount: string }>>`
              SELECT id, status, amount FROM bank.transfer_executions
               WHERE schedule_id = ${schedule.id} AND occurrence = ${occurrence} FOR UPDATE
            `;
            const row = existing[0];
            if (!row || row.status !== 'pending') return 'already-fired' as const;
            executionId = row.id;
            claimAmount = parseAmount(row.amount);
          } else {
            executionId = claimed[0]!.id;
          }
        } else {
          // Cancel/pause is not a reversal: an already-pending claim still
          // finishes. Unclaimed future firings must not start.
          const existing = await tx<Array<{ id: string; status: string; amount: string }>>`
            SELECT id, status, amount FROM bank.transfer_executions
             WHERE schedule_id = ${schedule.id} AND occurrence = ${occurrence} FOR UPDATE
          `;
          const row = existing[0];
          if (!row || row.status !== 'pending') return 'stopped' as const;
          executionId = row.id;
          claimAmount = parseAmount(row.amount);
        }

        let from: Awaited<ReturnType<SpaceService['get']>>;
        let to: Awaited<ReturnType<SpaceService['get']>>;
        try {
          // On `tx`, not the pool: this transaction already holds a connection,
          // and a second one from the same pool is a wait with no timeout
          // (GitHub issue #4621). Plain reads, no lock needed.
          from = await this.spaces.resolveForDebit(schedule.fromSpaceId, now, tx);
          to = await this.spaces.resolveForCredit(schedule.toSpaceId, { actingUserId: from.userId }, tx);
        } catch (err) {
          // `bank.recipient_cannot_receive` is a refusal of this occurrence like a
          // lock or an archive: recorded on the run, one code, no state named.
          // `bank.recipient_check_unavailable` / `_unset` are NOT here: identity
          // being down must not consume the occurrence, so they rethrow and the
          // claim rolls back for the next pass.
          if (
            err instanceof BankError &&
            (err.code === 'bank.space_locked' || err.code === 'bank.space_archived' || err.code === 'bank.recipient_cannot_receive')
          ) {
            // Crash window: claim rolled back (or never committed settle) AFTER
            // ledger.post already moved value under bank.transfer.sched:<id>:<n>. A
            // later lock must RECOVER that movement as settled — never mark
            // rejected while the ledger already moved money.
            const prior = await this.ledger.getTxByKey(bankTransferKey('sched', schedule.id, occurrence));
            if (prior) {
              await tx`
                UPDATE bank.transfer_executions
                   SET status = 'settled', ledger_tx_id = ${prior.id}, settled_at = now()
                 WHERE id = ${executionId}
              `;
              return 'settled';
            }
            await tx`
              UPDATE bank.transfer_executions
                 SET status = 'rejected', rejection_code = ${err.code}
               WHERE id = ${executionId}
            `;
            return 'rejected';
          }
          throw err;
        }

        return this.settle(tx, executionId, { ...schedule, amount: claimAmount }, from, to, occurrence);
      },
      // `read committed` is correct here because the ordering between competing
      // runs is already established by the unique index on (schedule,
      // occurrence): the loser blocks on the insert rather than racing ahead and
      // aborting. Serializable would add retries without adding safety.
      { isolation: 'read committed', maxAttempts: 5 },
    );
  }

  private async settle(
    tx: Sql,
    executionId: string,
    schedule: ScheduleRecord,
    from: Awaited<ReturnType<SpaceService['get']>>,
    to: Awaited<ReturnType<SpaceService['get']>>,
    occurrence: number,
  ): Promise<FiringOutcome> {
    try {
      const posted = await this.ledger.post(
        recipes.bankTransfer({
          transferId: schedule.id,
          occurrence,
          from: accountForSpace(from),
          to: accountForSpace(to),
          amount: schedule.amount,
          kind: 'scheduled',
          keySpace: 'sched',
        }),
      );

      await tx`
        UPDATE bank.transfer_executions
           SET status = 'settled', ledger_tx_id = ${posted.id}, settled_at = now()
         WHERE id = ${executionId}
      `;
      return 'settled';
    } catch (err) {
      // An empty space is an ordinary outcome for a standing order, not an
      // incident: record WHY and move on. The occurrence is consumed rather than
      // queued — a monthly transfer that failed in March is a March transfer,
      // and silently making it up in April would move money the user is no
      // longer expecting to move.
      if (err instanceof InsufficientFundsError || (err instanceof LedgerError && err.code === 'ledger.insufficient_funds')) {
        await tx`
          UPDATE bank.transfer_executions
             SET status = 'rejected', rejection_code = ${err.code}
           WHERE id = ${executionId}
        `;
        return 'rejected';
      }
      // Anything else — a network fault reaching svc-ledger, a frozen module —
      // must NOT consume the occurrence. Rethrowing rolls the claim back so the
      // next pass tries again.
      throw err;
    }
  }

  /** Firing history for a schedule — what ran, what did not, and why. */
  async executions(
    scheduleId: string,
    limit?: number,
  ): Promise<Array<{ occurrence: number; amount: string; status: string; ledgerTxId: string | null; rejectionCode: string | null }>> {
    const page = assertExecutionsListLimit(limit);
    const rows = await this.sql<
      Array<{ occurrence: number; amount: string; status: string; ledger_tx_id: string | null; rejection_code: string | null }>
    >`
      SELECT occurrence, amount, status, ledger_tx_id, rejection_code
        FROM bank.transfer_executions WHERE schedule_id = ${scheduleId} ORDER BY occurrence ASC
       LIMIT ${page}
    `;
    return rows.map((r) => ({
      occurrence: r.occurrence,
      amount: formatAmount(parseAmount(r.amount)),
      status: r.status,
      ledgerTxId: r.ledger_tx_id,
      rejectionCode: r.rejection_code,
    }));
  }

  /** When occurrence `n` of a schedule is due — exposed for operator tooling and tests. */
  static occurrenceAt(startsAt: Date, cadence: ScheduleCadence, occurrence: number): Date {
    return occurrenceStart(startsAt, cadence, occurrence);
  }
}
