import type { Sql } from 'postgres';
import {
  InsufficientFundsError,
  InvalidEntryError,
  formatAmount,
  parseAmount,
  userAvailable,
  type LedgerClient,
} from '@intafaced/ledger-client';
import { BankError } from '../errors.js';
import { withSessionAdvisoryLock } from '../session-lock.js';
import type { SpaceService } from '../spaces/space-service.js';
import { forwardKey, postToRail } from '../personal-pay/post.js';
import type { DirectDebitScheme } from './scheme.js';

/**
 * Direct Debit mandates and their collections (BK-xfer-11, J-bank-06 #4).
 *
 * A mandate is set up by a creditor through the scheme, never by this service: the scheme's door is a signed job call,
 * and on the stack the TEST stand-in (`dd-sim`) answers it. The person sees each mandate, its upcoming collections for
 * the next month and its past ones, blocks it (and can unblock it), and asks for a refund of a collected debit inside
 * the guarantee period. A collection debits the person's main balance in the mandate's asset once, through the
 * `bankTransfer` recipe to the scheme's rail boundary, under `bank.transfer.rail:dd:<mandate>:<collection>:0`.
 *
 * States of a collection: `upcoming` until it is due; `processing` once a run has claimed it (from here a block is too
 * late for it); `collected` with the ledger entry; `failed` when the ledger refused it (too little money: nothing is
 * posted); `rejected` when it was refused before any attempt (a blocked mandate, an account that cannot be debited).
 *
 * One run drives one collection at a time, under that collection's own lock held across the post, so two overlapping
 * runs never both debit or both decide it. The claim is one statement that reads the mandate without locking it, so a
 * block (which locks the mandate, then its collections) never waits on a run in the other order. The refund guarantee
 * window is fixed on the collection when it is collected.
 *
 * If this crashes exactly here, whose funds are stranded? No one's: a crash after the post and before the row is marked
 * leaves the row `processing`, and the next run finds the entry by its key and records it instead of posting again. A
 * fault that will not pass (an entry the ledger refuses as invalid, a space that can never be debited) ends the
 * collection `failed` with nothing posted; an outage leaves it `processing` for the next run.
 */

/** How far ahead "upcoming" looks: the next month, as the person reads it. */
const UPCOMING_DAYS = 31;
const DAY_MS = 86_400_000;
const LOCK = 'bank.dd-collection';

export const DD_COLLECTION_STATUSES = ['upcoming', 'processing', 'collected', 'failed', 'rejected'] as const;
export type CollectionStatus = (typeof DD_COLLECTION_STATUSES)[number];

/** A failed collection's fee: the owner has no failure fee table, so it is not set and nothing is charged. */
export const DD_FAILURE_FEE_UNSET = 'bank.dd_failure_fee_unset';

type MandateRow = {
  id: string;
  user_id: string;
  scheme: string;
  creditor_id: string;
  creditor_name: string;
  reference: string;
  asset_id: string;
  status: 'active' | 'blocked';
  blocked_at: Date | null;
  created_at: Date;
};

type CollectionRow = {
  id: string;
  mandate_id: string;
  collection_id: string;
  user_id: string;
  asset_id: string;
  amount: string;
  due_at: Date;
  status: CollectionStatus;
  failure_code: string | null;
  ledger_tx_id: string | null;
  presented_at: Date;
  settled_at: Date | null;
  creditor_name: string;
  guarantee_ends_at: Date | null;
  refund_requested_at: Date | null;
  refund_reason: string | null;
};

export interface RefundView {
  /** `available` until `endsAt`; `requested` once asked; `closed` after the period; `unset` with no guarantee period. */
  readonly state: 'none' | 'available' | 'requested' | 'closed' | 'unset';
  readonly endsAt: string | null;
  readonly requestedAt: string | null;
}

export interface CollectionView {
  readonly id: string;
  readonly mandateId: string;
  readonly collectionId: string;
  readonly creditorName: string;
  readonly assetId: string;
  readonly amount: string;
  readonly dueAt: string;
  readonly status: CollectionStatus;
  readonly failureCode: string | null;
  readonly ledgerTxId: string | null;
  readonly presentedAt: string;
  readonly settledAt: string | null;
  /** Never a number nobody set: a failed collection's fee is null with its blocker. */
  readonly failureFee: null;
  readonly failureFeeBlocker: typeof DD_FAILURE_FEE_UNSET | null;
  readonly refund: RefundView;
}

export interface MandateView {
  readonly id: string;
  readonly creditorId: string;
  readonly creditorName: string;
  readonly reference: string;
  readonly assetId: string;
  readonly status: 'active' | 'blocked';
  readonly blockedAt: string | null;
  readonly createdAt: string;
  readonly upcoming: CollectionView[];
}

export interface DirectDebitsView {
  readonly scheme: {
    readonly status: 'unset' | 'live';
    readonly standIn: string | null;
    readonly guaranteeDays: number | null;
    readonly blocker: 'rail.bank' | null;
  };
  readonly mandates: MandateView[];
  readonly collections: CollectionView[];
}

export interface DirectDebitRunReport {
  considered: number;
  collected: number;
  failed: number;
  rejected: number;
  failures: Array<{ collectionId: string; reason: string; code?: string }>;
}

const MANDATE_COLUMNS = 'id, user_id, scheme, creditor_id, creditor_name, reference, asset_id, status, blocked_at, created_at';

function iso(at: Date | null): string | null {
  return at ? at.toISOString() : null;
}

function amountOf(raw: string): string {
  return formatAmount(parseAmount(raw));
}

function invalid(message: string): never {
  throw new BankError(message, 'bank.dd_invalid');
}

/** The ledger transfer id of one collection. Its posting key is `bank.transfer.rail:<this>:0`. */
export function collectionTransferId(mandateId: string, collectionId: string): string {
  return `dd:${mandateId}:${collectionId}`;
}

export class DirectDebitService {
  constructor(
    private readonly sql: Sql,
    private readonly ledger: LedgerClient,
    private readonly spaces: SpaceService,
    private readonly scheme: DirectDebitScheme,
  ) {}

  /** Every control refuses `rail.bank` while no scheme is wired. */
  private requireScheme(): void {
    if (this.scheme.status !== 'live') {
      throw new BankError('No direct debit scheme is connected (rail.bank); nothing was changed.', 'rail.bank');
    }
  }

  private refundOf(row: CollectionRow, now: Date): RefundView {
    if (row.refund_requested_at) {
      return { state: 'requested', endsAt: this.refundEnd(row), requestedAt: row.refund_requested_at.toISOString() };
    }
    if (row.status !== 'collected' || !row.settled_at) return { state: 'none', endsAt: null, requestedAt: null };
    const endsAt = this.refundEnd(row);
    if (endsAt === null) return { state: 'unset', endsAt: null, requestedAt: null };
    return { state: new Date(endsAt) > now ? 'available' : 'closed', endsAt, requestedAt: null };
  }

  /** The window as fixed when the debit was collected; null when no guarantee period was set then. */
  private refundEnd(row: CollectionRow): string | null {
    return iso(row.guarantee_ends_at);
  }

  private collectionView(row: CollectionRow, now: Date): CollectionView {
    return {
      id: row.id,
      mandateId: row.mandate_id,
      collectionId: row.collection_id,
      creditorName: row.creditor_name,
      assetId: row.asset_id,
      amount: amountOf(row.amount),
      dueAt: row.due_at.toISOString(),
      status: row.status,
      failureCode: row.failure_code,
      ledgerTxId: row.ledger_tx_id,
      presentedAt: row.presented_at.toISOString(),
      settledAt: iso(row.settled_at),
      failureFee: null,
      failureFeeBlocker: row.status === 'failed' ? DD_FAILURE_FEE_UNSET : null,
      refund: this.refundOf(row, now),
    };
  }

  private mandateView(row: MandateRow, upcoming: CollectionView[]): MandateView {
    return {
      id: row.id,
      creditorId: row.creditor_id,
      creditorName: row.creditor_name,
      reference: row.reference,
      assetId: row.asset_id,
      status: row.status,
      blockedAt: iso(row.blocked_at),
      createdAt: row.created_at.toISOString(),
      upcoming,
    };
  }

  private async collections(
    db: Sql,
    where: {
      userId?: string;
      rowId?: string;
      upcomingUntil?: Date;
      history?: boolean;
      /** Every status due in `[from, to)`, soonest first, `limit` rows. */
      due?: { from: Date; to: Date; limit: number };
    },
  ): Promise<CollectionRow[]> {
    const until = where.upcomingUntil ?? null;
    const due = where.due ?? null;
    return db<CollectionRow[]>`
      SELECT c.id, c.mandate_id, c.collection_id, c.user_id, c.asset_id, c.amount::text AS amount, c.due_at, c.status,
             c.failure_code, c.ledger_tx_id, c.presented_at, c.settled_at, c.guarantee_ends_at, m.creditor_name,
             r.requested_at AS refund_requested_at, r.reason AS refund_reason
        FROM bank.dd_collections c
        JOIN bank.dd_mandates m ON m.id = c.mandate_id
        LEFT JOIN bank.dd_refund_requests r ON r.collection_row_id = c.id
       WHERE (${where.userId ?? null}::uuid IS NULL OR c.user_id = ${where.userId ?? null}::uuid)
         AND (${where.rowId ?? null}::uuid IS NULL OR c.id = ${where.rowId ?? null}::uuid)
         AND (${until}::timestamptz IS NULL OR (c.status = 'upcoming' AND c.due_at <= ${until}::timestamptz))
         AND (${where.history ?? false} = false OR c.status <> 'upcoming')
         AND (${due?.from ?? null}::timestamptz IS NULL OR c.due_at >= ${due?.from ?? null}::timestamptz)
         AND (${due?.to ?? null}::timestamptz IS NULL OR c.due_at < ${due?.to ?? null}::timestamptz)
       ORDER BY ${due ? db`c.due_at ASC, c.id ASC` : db`c.due_at DESC, c.id DESC`}
       LIMIT ${due?.limit ?? 200}
    `;
  }

  /** The person's collections due in `[from, to)`, soonest first, for the money calendar. */
  async dated(input: { userId: string; from: Date; to: Date; limit: number; now?: Date }): Promise<CollectionView[]> {
    const now = input.now ?? new Date();
    const rows = await this.collections(this.sql, { userId: input.userId, due: { from: input.from, to: input.to, limit: input.limit } });
    return rows.map((row) => this.collectionView(row, now));
  }

  /** The person's mandates with their upcoming collections, and their collections newest first. */
  async list(userId: string, now: Date = new Date()): Promise<DirectDebitsView> {
    const scheme = {
      status: this.scheme.status,
      standIn: this.scheme.standIn,
      guaranteeDays: this.scheme.guaranteeDays,
      blocker: this.scheme.status === 'live' ? null : ('rail.bank' as const),
    };
    // The next month's upcoming collections and the history are read apart, so a long run of future presentments never
    // pushes past debits (and their refund buttons) out of the list.
    const [mandates, upcoming, history] = await Promise.all([
      this.sql<MandateRow[]>`
        SELECT ${this.sql.unsafe(MANDATE_COLUMNS)} FROM bank.dd_mandates WHERE user_id = ${userId}
         ORDER BY created_at DESC, id LIMIT 100
      `,
      this.collections(this.sql, { userId, upcomingUntil: new Date(now.getTime() + UPCOMING_DAYS * DAY_MS) }),
      this.collections(this.sql, { userId, history: true }),
    ]);
    const next = upcoming.map((row) => this.collectionView(row, now)).sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
    return {
      scheme,
      mandates: mandates.map((m) =>
        this.mandateView(
          m,
          next.filter((c) => c.mandateId === m.id),
        ),
      ),
      collections: history.map((row) => this.collectionView(row, now)),
    };
  }

  private async ownedMandate(db: Sql, userId: string, mandateId: string, lock: boolean): Promise<MandateRow> {
    const rows = lock
      ? await db<MandateRow[]>`SELECT ${db.unsafe(MANDATE_COLUMNS)} FROM bank.dd_mandates WHERE id = ${mandateId} FOR UPDATE`
      : await db<MandateRow[]>`SELECT ${db.unsafe(MANDATE_COLUMNS)} FROM bank.dd_mandates WHERE id = ${mandateId}`;
    const row = rows[0];
    // Another person's mandate reads as missing: the refusal names nothing of theirs.
    if (!row || row.user_id !== userId) throw new BankError('No such direct debit mandate.', 'bank.dd_mandate_not_found');
    return row;
  }

  /**
   * Block a mandate. Its upcoming collections are rejected now with `bank.dd_mandate_blocked`, and any collection the
   * creditor presents later is rejected the same way. A collection a run has already claimed cannot be stopped: it is
   * named in `tooLate` with `bank.dd_too_late`. Blocking a blocked mandate changes nothing and answers the same.
   */
  async block(input: { userId: string; mandateId: string; now?: Date }): Promise<{
    mandate: MandateView;
    rejected: string[];
    tooLate: Array<{ collectionId: string; code: 'bank.dd_too_late' }>;
  }> {
    this.requireScheme();
    const now = input.now ?? new Date();
    const result = await this.sql.begin(async (tx) => {
      const mandate = await this.ownedMandate(tx as unknown as Sql, input.userId, input.mandateId, true);
      if (mandate.status === 'active') {
        await tx`UPDATE bank.dd_mandates SET status = 'blocked', blocked_at = ${now}, updated_at = now() WHERE id = ${mandate.id}`;
      }
      const rejected = await tx<{ collection_id: string }[]>`
        UPDATE bank.dd_collections SET status = 'rejected', failure_code = 'bank.dd_mandate_blocked', settled_at = ${now}
         WHERE mandate_id = ${mandate.id} AND status = 'upcoming'
        RETURNING collection_id
      `;
      const busy = await tx<{ collection_id: string }[]>`
        SELECT collection_id FROM bank.dd_collections WHERE mandate_id = ${mandate.id} AND status = 'processing'
      `;
      return { rejected: rejected.map((r) => r.collection_id), tooLate: busy.map((r) => r.collection_id) };
    });
    const mandate = await this.ownedMandate(this.sql, input.userId, input.mandateId, false);
    return {
      mandate: this.mandateView(mandate, []),
      rejected: result.rejected,
      tooLate: result.tooLate.map((collectionId) => ({ collectionId, code: 'bank.dd_too_late' as const })),
    };
  }

  /** Unblock a mandate: collections the creditor presents from now on are collected again. Rejected ones stay rejected. */
  async unblock(input: { userId: string; mandateId: string }): Promise<{ mandate: MandateView }> {
    this.requireScheme();
    await this.sql.begin(async (tx) => {
      const mandate = await this.ownedMandate(tx as unknown as Sql, input.userId, input.mandateId, true);
      if (mandate.status === 'blocked') {
        await tx`UPDATE bank.dd_mandates SET status = 'active', blocked_at = NULL, updated_at = now() WHERE id = ${mandate.id}`;
      }
    });
    const mandate = await this.ownedMandate(this.sql, input.userId, input.mandateId, false);
    return { mandate: this.mandateView(mandate, []) };
  }

  /**
   * Ask for a collected debit back inside the guarantee period. One request per collection: asking again answers the
   * first request. Support reads it (`opsRefunds`); the credit back is the scheme's answer and is not made here.
   */
  async requestRefund(input: { userId: string; collectionRowId: string; reason: string; now?: Date }): Promise<{
    collection: CollectionView;
    created: boolean;
  }> {
    this.requireScheme();
    const now = input.now ?? new Date();
    const reason = input.reason.trim();
    if (reason.length < 1 || reason.length > 500) invalid('Say in up to 500 characters why this debit should be refunded.');
    const row = (await this.collections(this.sql, { rowId: input.collectionRowId }))[0];
    if (!row || row.user_id !== input.userId) throw new BankError('No such direct debit collection.', 'bank.dd_collection_not_found');
    if (row.refund_requested_at) return { collection: this.collectionView(row, now), created: false };
    if (row.status !== 'collected') {
      throw new BankError(
        'Only a debit that was collected can be refunded; nothing was taken for this one.',
        'bank.dd_refund_not_collected',
      );
    }
    const endsAt = this.refundEnd(row);
    if (endsAt === null) {
      throw new BankError('The direct debit guarantee period is not set, so no refund can be requested.', 'bank.dd_guarantee_unset');
    }
    if (new Date(endsAt) <= now) {
      throw new BankError(`The guarantee period for this debit ended on ${endsAt}.`, 'bank.dd_refund_window_closed');
    }
    const inserted = await this.sql`
      INSERT INTO bank.dd_refund_requests (collection_row_id, user_id, reason, guarantee_ends_at, requested_at)
      VALUES (${row.id}, ${row.user_id}, ${reason}, ${endsAt}::timestamptz, ${now})
      ON CONFLICT (collection_row_id) DO NOTHING
    `;
    const after = (await this.collections(this.sql, { rowId: row.id }))[0]!;
    return { collection: this.collectionView(after, now), created: inserted.count === 1 };
  }

  /** Support's queue: refund requests, oldest first, with whose they are. */
  async opsRefunds(
    input: { limit?: number } = {},
    now: Date = new Date(),
  ): Promise<Array<CollectionView & { userId: string; reason: string }>> {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
    const rows = await this.sql<CollectionRow[]>`
      SELECT c.id, c.mandate_id, c.collection_id, c.user_id, c.asset_id, c.amount::text AS amount, c.due_at, c.status,
             c.failure_code, c.ledger_tx_id, c.presented_at, c.settled_at, c.guarantee_ends_at, m.creditor_name,
             r.requested_at AS refund_requested_at, r.reason AS refund_reason
        FROM bank.dd_refund_requests r
        JOIN bank.dd_collections c ON c.id = r.collection_row_id
        JOIN bank.dd_mandates m ON m.id = c.mandate_id
       ORDER BY r.requested_at ASC, c.id
       LIMIT ${limit}
    `;
    return rows.map((row) => ({ ...this.collectionView(row, now), userId: row.user_id, reason: row.refund_reason ?? '' }));
  }

  // ── The scheme's side: signed job doors, never a customer ─────────────────────────────────────────────────────────

  /** A creditor sets up a mandate through the scheme. The same mandate again answers the first; other terms refuse. */
  async setUpMandate(input: {
    mandateId: string;
    userId: string;
    creditorId: string;
    reference: string;
    assetId: string;
  }): Promise<MandateView & { userId: string }> {
    this.requireScheme();
    const creditor = this.scheme.creditor(input.creditorId);
    if (!creditor) throw new BankError('The scheme knows no creditor by that id.', 'bank.dd_creditor_unknown');
    // Identity says whether this person's account is open; unknown, frozen and closed are refused with one code.
    await this.spaces.assertCanReceive(input.userId);
    const scheme = this.scheme.standIn ? 'dd-sim' : 'live';
    await this.sql`
      INSERT INTO bank.dd_mandates (id, user_id, scheme, creditor_id, creditor_name, reference, asset_id)
      VALUES (${input.mandateId}, ${input.userId}, ${scheme}, ${creditor.id}, ${creditor.name}, ${input.reference}, ${input.assetId})
      ON CONFLICT (id) DO NOTHING
    `;
    const row = (
      await this.sql<MandateRow[]>`
      SELECT ${this.sql.unsafe(MANDATE_COLUMNS)} FROM bank.dd_mandates WHERE id = ${input.mandateId}
    `
    )[0]!;
    if (
      row.user_id !== input.userId ||
      row.creditor_id !== creditor.id ||
      row.reference !== input.reference ||
      row.asset_id !== input.assetId
    ) {
      throw new BankError('That mandate id is already set up with other terms.', 'bank.dd_mandate_conflict');
    }
    return { ...this.mandateView(row, []), userId: row.user_id };
  }

  /**
   * A creditor presents one collection. A replay of the same presentment is one row; the same id with another amount or
   * date refuses. Against a blocked mandate it is recorded `rejected` with `bank.dd_mandate_blocked`, nothing posted.
   */
  async present(input: {
    mandateId: string;
    collectionId: string;
    amount: string;
    dueAt: string;
    now?: Date;
  }): Promise<CollectionView & { userId: string }> {
    this.requireScheme();
    const now = input.now ?? new Date();
    let amount: bigint;
    try {
      amount = parseAmount(input.amount);
    } catch {
      invalid('The collection amount must be a decimal string.');
    }
    if (amount <= 0n) invalid('The collection amount must be more than zero.');
    const dueAt = new Date(input.dueAt);
    if (Number.isNaN(dueAt.getTime())) invalid('The collection needs a due date.');
    const rowId = await this.sql.begin(async (tx) => {
      // FOR SHARE orders this with a block, which takes the row FOR UPDATE.
      const mandate = (
        await tx<MandateRow[]>`
        SELECT ${tx.unsafe(MANDATE_COLUMNS)} FROM bank.dd_mandates WHERE id = ${input.mandateId} FOR SHARE
      `
      )[0];
      if (!mandate) throw new BankError('No such direct debit mandate.', 'bank.dd_mandate_not_found');
      const blocked = mandate.status === 'blocked';
      await tx`
        INSERT INTO bank.dd_collections (mandate_id, collection_id, user_id, asset_id, amount, due_at, status, failure_code, settled_at)
        VALUES (${mandate.id}, ${input.collectionId}, ${mandate.user_id}, ${mandate.asset_id}, ${formatAmount(amount)}, ${dueAt},
                ${blocked ? 'rejected' : 'upcoming'}, ${blocked ? 'bank.dd_mandate_blocked' : null}, ${blocked ? now : null})
        ON CONFLICT (mandate_id, collection_id) DO NOTHING
      `;
      const kept = (
        await tx<{ id: string; amount: string; due_at: Date }[]>`
        SELECT id, amount::text AS amount, due_at FROM bank.dd_collections
         WHERE mandate_id = ${mandate.id} AND collection_id = ${input.collectionId}
      `
      )[0]!;
      if (parseAmount(kept.amount) !== amount || kept.due_at.getTime() !== dueAt.getTime()) {
        throw new BankError('That collection id was presented with another amount or date.', 'bank.dd_collection_conflict');
      }
      return kept.id;
    });
    const row = (await this.collections(this.sql, { rowId }))[0]!;
    return { ...this.collectionView(row, now), userId: row.user_id };
  }

  /** The collection run: every due collection is collected, failed or rejected once. One fault never stops the rest. */
  async runDue(options: { limit: number; now?: Date }): Promise<DirectDebitRunReport> {
    this.requireScheme();
    const now = options.now ?? new Date();
    const due = await this.sql<{ id: string }[]>`
      SELECT id FROM bank.dd_collections WHERE status IN ('upcoming', 'processing') AND due_at <= ${now}
       ORDER BY due_at ASC, id LIMIT ${options.limit}
    `;
    const report: DirectDebitRunReport = { considered: due.length, collected: 0, failed: 0, rejected: 0, failures: [] };
    for (const { id } of due) {
      try {
        const outcome = await this.drive(id, now);
        if (outcome) report[outcome] += 1;
      } catch (err) {
        report.failures.push({
          collectionId: id,
          reason: err instanceof Error ? err.message : String(err),
          ...(err instanceof BankError ? { code: err.code } : {}),
        });
      }
    }
    return report;
  }

  private async finish(id: string, status: 'failed' | 'rejected', code: string, now: Date): Promise<typeof status> {
    const done = await this.sql`
      UPDATE bank.dd_collections SET status = ${status}, failure_code = ${code}, settled_at = ${now}
       WHERE id = ${id} AND status IN ('upcoming', 'processing') AND ledger_tx_id IS NULL
    `;
    if (done.count !== 1) throw new BankError('The collection changed while it was being decided.', 'bank.dd_collection_conflict');
    return status;
  }

  private async drive(id: string, now: Date): Promise<'collected' | 'failed' | 'rejected' | null> {
    return withSessionAdvisoryLock(this.sql, LOCK, id, async () => {
      const row = (
        await this.sql<
          {
            id: string;
            mandate_id: string;
            collection_id: string;
            user_id: string;
            asset_id: string;
            amount: string;
            status: CollectionStatus;
            mandate_status: string;
          }[]
        >`
        SELECT c.id, c.mandate_id, c.collection_id, c.user_id, c.asset_id, c.amount::text AS amount, c.status,
               m.status AS mandate_status
          FROM bank.dd_collections c JOIN bank.dd_mandates m ON m.id = c.mandate_id
         WHERE c.id = ${id}
      `
      )[0];
      if (!row || (row.status !== 'upcoming' && row.status !== 'processing')) return null;
      if (row.status === 'upcoming') {
        if (row.mandate_status !== 'active') return this.finish(row.id, 'rejected', 'bank.dd_mandate_blocked', now);
        // Claimed only while its mandate is still active, in one statement: a block that got there first wins.
        const claimed = await this.sql`
          UPDATE bank.dd_collections c SET status = 'processing'
           WHERE c.id = ${row.id} AND c.status = 'upcoming'
             AND EXISTS (SELECT 1 FROM bank.dd_mandates m WHERE m.id = c.mandate_id AND m.status = 'active')
        `;
        if (claimed.count !== 1) return null;
      }

      const transferId = collectionTransferId(row.mandate_id, row.collection_id);
      // An entry that posted before a crash is recorded, never posted again.
      let tx = await this.ledger.getTxByKey(forwardKey(transferId));
      if (!tx) {
        try {
          await this.spaces.assertCanReceive(row.user_id);
        } catch (err) {
          // A frozen, closed or unknown account is not debited; an identity outage leaves the row processing for a retry.
          if (err instanceof BankError && err.code === 'bank.recipient_cannot_receive') {
            return this.finish(row.id, 'rejected', 'bank.dd_account_unavailable', now);
          }
          throw err;
        }
        const primary = await this.spaces.findPrimary(row.user_id, row.asset_id);
        if (primary) {
          try {
            await this.spaces.resolveForDebit(primary.id, now);
          } catch (err) {
            // The main balance cannot be debited (locked, archived): failed by that reason, nothing posted.
            if (err instanceof BankError) return this.finish(row.id, 'failed', err.code, now);
            throw err;
          }
        }
        try {
          tx = await postToRail(
            this.ledger,
            transferId,
            userAvailable(row.user_id, row.asset_id),
            this.scheme.railId,
            parseAmount(row.amount),
          );
        } catch (err) {
          if (err instanceof InsufficientFundsError) return this.finish(row.id, 'failed', 'bank.insufficient_funds', now);
          // The ledger refused the entry itself (an asset it does not hold, say): it never will post, so it fails.
          if (err instanceof InvalidEntryError) return this.finish(row.id, 'failed', 'bank.dd_collection_invalid', now);
          // A posting freeze or a lost answer: the row stays processing and the next run looks the key up first.
          throw err;
        }
      }
      const days = this.scheme.guaranteeDays;
      const ends = days === null ? null : new Date(now.getTime() + days * DAY_MS);
      const done = await this.sql`
        UPDATE bank.dd_collections SET status = 'collected', ledger_tx_id = ${tx.id}, settled_at = ${now}, failure_code = NULL,
               guarantee_ends_at = ${ends}
         WHERE id = ${row.id} AND status = 'processing'
      `;
      if (done.count !== 1) throw new BankError('The collection changed while it was being collected.', 'bank.dd_collection_conflict');
      return 'collected';
    });
  }
}
