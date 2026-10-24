import { z } from 'zod';
import type { Sql } from 'postgres';
import {
  LedgerError,
  POST_IN_FLIGHT_BOUND_SECONDS,
  bankTransferKey,
  formatAmount,
  parseAmount,
  provesPostNotCommitted,
  recipes,
  subAccountAvailable,
  userAvailable,
  type Amount,
  type LedgerClient,
} from '@intafaced/ledger-client';
import { BankError } from '../errors.js';
import { accountForSpace, type SpaceService } from '../spaces/space-service.js';
import { withMoneySpan } from '../tracing.js';
import { bookedTransferMatches } from '../transfers/booked-transfer.js';

/**
 * INCOME SORTER (BK-pots-03, J-bank-07 #4).
 *
 * A payment from another person into the account is split across the person's own named spaces by percentage, once.
 * The sorter is an instruction; the credit is the posted row in `bank.personal_transfers`; each split is an own-space
 * `bankTransfer` from the account into one space, keyed `sorter:<sorter>:<credit ledger tx>` with the leg's position as
 * its occurrence. Whatever is not sorted stays in the account. No balance lives here.
 *
 * Two paths drive a credit, and both end in the same keys: the send that posted it (right after the post) and the
 * sweep (`run-income-sorter`), which picks up a credit whose send crashed before sorting and any split whose outcome was
 * unknown. A credit has one run, ever (`income_sorter_runs.credit_transfer_id` is unique), so it is sorted once by the
 * sorter that was live when it arrived.
 *
 * The owner decides whether credits are sorted at all and from what size (`BANK_INCOME_SORTER_MIN_CREDIT`). Blank:
 * making a sorter refuses `bank.sorter_terms_unset`, and no credit is sorted.
 */

export const SORTER_MAX_LEGS = 10;
const FULL_BP = 10_000;
/** A run younger than this is left to the send that made it; the sweep drives only older ones. */
const SWEEP_AFTER_MS = 60_000;

export type SorterStatus = 'active' | 'cancelled';
export type SorterLegStatus = 'pending' | 'settled' | 'rejected';
/** Why a payment that reached a live sorter was recorded and not split. */
export type SorterSkip = 'below_minimum' | 'terms_unset';

export interface SorterLeg {
  spaceId: string;
  /** Share of each credit in basis points (6000 = 60%). */
  shareBp: number;
}

export interface IncomeSorter {
  id: string;
  userId: string;
  assetId: string;
  status: SorterStatus;
  legs: SorterLeg[];
  createdAt: Date;
  cancelledAt: Date | null;
}

/** A live sorter as the person reads it: each target space's name, and whether it has been archived since. */
export interface ListedSorter extends IncomeSorter {
  spaces: Record<string, { name: string; archived: boolean }>;
}

export interface SorterRunLeg {
  position: number;
  spaceId: string;
  amount: Amount;
  status: SorterLegStatus;
  ledgerTxId: string | null;
  rejectionCode: string | null;
  settledAt: Date | null;
}

export interface SorterRun {
  id: string;
  sorterId: string;
  creditTransferId: string;
  creditTxId: string;
  creditAmount: Amount;
  /** When the payment itself posted; `createdAt` is when it was sorted. */
  creditPostedAt: Date;
  /** Set when the payment was recorded and not split: it was under the bank's smallest sorted payment, or no terms stood. */
  skippedReason: SorterSkip | null;
  createdAt: Date;
  legs: SorterRunLeg[];
}

/** A posted payment from another person, as `bank.personal_transfers` holds it. */
export interface IncomingCredit {
  transferId: string;
  fromUserId: string;
  toUserId: string;
  assetId: string;
  amount: Amount;
  ledgerTxId: string;
  postedAt: Date;
}

/**
 * What one credit came to. `unsorted` moved nothing and recorded nothing: no live sorter when it arrived, or the person's
 * own money. `recorded` is its one run: split into legs, or skipped with a reason (and then never looked at again).
 */
export type SortOutcome = { status: 'unsorted'; reason: 'no_sorter' | 'own_money' } | { status: 'recorded'; run: SorterRun };

export interface SorterSweepReport {
  /** Payments that reached a live sorter and had no run: their send never sorted them. */
  creditsRecorded: number;
  runsDriven: number;
  legsStillPending: number;
}

interface SorterRow {
  id: string;
  user_id: string;
  asset_id: string;
  status: SorterStatus;
  created_at: Date;
  cancelled_at: Date | null;
}

interface LegRow {
  sorter_id: string;
  position: number;
  space_id: string;
  share_bp: number;
}

interface RunRow {
  id: string;
  sorter_id: string;
  credit_transfer_id: string;
  credit_tx_id: string;
  credit_amount: string;
  credit_posted_at: Date;
  skipped_reason: SorterSkip | null;
  created_at: Date;
}

interface RunLegRow {
  run_id: string;
  position: number;
  space_id: string;
  amount: string;
  status: SorterLegStatus;
  ledger_tx_id: string | null;
  rejection_code: string | null;
  settled_at: Date | null;
}

const SORTER_COLS = 'id, user_id, asset_id, status, created_at, cancelled_at';
const RUN_COLS =
  'id, sorter_id, credit_transfer_id, credit_tx_id, credit_amount::text AS credit_amount, credit_posted_at, skipped_reason, created_at';
const RUN_LEG_COLS = 'run_id, position, space_id, amount::text AS amount, status, ledger_tx_id, rejection_code, settled_at';

/** The ledger key's transfer id for one credit under one sorter. Longer than any id `transfers.create` accepts (64). */
export function sorterTransferId(sorterId: string, creditTxId: string): string {
  return `sorter:${sorterId}:${creditTxId}`;
}

/** One leg's share of a credit, rounded down at the ledger's scale: a split never moves more than its share. */
export function legShare(credit: Amount, shareBp: number): Amount {
  return (credit * BigInt(shareBp)) / BigInt(FULL_BP);
}

/** Parse the owner's minimum credit; blank or not a non-negative decimal is not a decision. */
export function parseMinCredit(raw: string | undefined): Amount | null {
  const value = raw?.trim();
  if (!value || !/^\d+(\.\d{1,18})?$/.test(value)) return null;
  return parseAmount(value);
}

function legRefusalCode(err: unknown): string {
  if (err instanceof BankError) return err.code;
  if (err instanceof LedgerError) return err.code;
  return 'bank.sorter_split_failed';
}

function toSorter(row: SorterRow, legs: LegRow[]): IncomeSorter {
  return {
    id: row.id,
    userId: row.user_id,
    assetId: row.asset_id,
    status: row.status,
    legs: legs
      .filter((leg) => leg.sorter_id === row.id)
      .sort((a, b) => a.position - b.position)
      .map((leg) => ({ spaceId: leg.space_id, shareBp: leg.share_bp })),
    createdAt: row.created_at,
    cancelledAt: row.cancelled_at,
  };
}

function toRunLeg(row: RunLegRow): SorterRunLeg {
  return {
    position: row.position,
    spaceId: row.space_id,
    amount: parseAmount(row.amount),
    status: row.status,
    ledgerTxId: row.ledger_tx_id,
    rejectionCode: row.rejection_code,
    settledAt: row.settled_at,
  };
}

function toRun(row: RunRow, legs: RunLegRow[]): SorterRun {
  return {
    id: row.id,
    sorterId: row.sorter_id,
    creditTransferId: row.credit_transfer_id,
    creditTxId: row.credit_tx_id,
    creditAmount: parseAmount(row.credit_amount),
    creditPostedAt: row.credit_posted_at,
    skippedReason: row.skipped_reason,
    createdAt: row.created_at,
    legs: legs
      .filter((leg) => leg.run_id === row.id)
      .sort((a, b) => a.position - b.position)
      .map(toRunLeg),
  };
}

const sameLegs = (a: SorterLeg[], b: SorterLeg[]) =>
  a.length === b.length && a.every((leg, i) => leg.spaceId === b[i]!.spaceId && leg.shareBp === b[i]!.shareBp);

export class IncomeSorterService {
  constructor(
    private readonly sql: Sql,
    private readonly ledger: Pick<LedgerClient, 'post' | 'getTx' | 'getTxByKey' | 'balance'>,
    private readonly spaces: Pick<SpaceService, 'get' | 'findPrimary' | 'resolveForDebit' | 'resolveForCredit'>,
    private readonly options: { minCredit?: () => string | undefined } = {},
  ) {}

  /** The owner's smallest credit that is sorted, or null while the owner has published none. */
  minimumCredit(): Amount | null {
    return parseMinCredit(this.options.minCredit?.());
  }

  /** The owner's smallest credit that is sorted. Blank refuses: the owner has not said credits are sorted at all. */
  private minCredit(): Amount {
    const min = this.minimumCredit();
    if (min === null) {
      throw new BankError(
        'The bank has not published when incoming payments are sorted (bank.sorter_terms_unset)',
        'bank.sorter_terms_unset',
      );
    }
    return min;
  }

  /**
   * Make the account's sorter for one asset: each leg one of the person's own live named spaces of that asset, with a
   * whole-number share in basis points; the shares total at most 100% and the rest stays in the account. The client's
   * `sorterId` makes a retry the same sorter. One live sorter per asset (`bank.sorter_exists`); cancel it first.
   */
  async create(input: { userId: string; sorterId: string; assetId: string; legs: SorterLeg[] }): Promise<IncomeSorter> {
    this.minCredit();
    const legs = input.legs.map((leg) => ({ spaceId: leg.spaceId, shareBp: leg.shareBp }));
    if (legs.length < 1 || legs.length > SORTER_MAX_LEGS) {
      throw new BankError(`A sorter has 1 to ${SORTER_MAX_LEGS} spaces`, 'bank.sorter_invalid');
    }
    if (new Set(legs.map((leg) => leg.spaceId)).size !== legs.length) {
      throw new BankError('Each space appears once in a sorter', 'bank.sorter_invalid');
    }
    let total = 0;
    for (const leg of legs) {
      if (!Number.isInteger(leg.shareBp) || leg.shareBp < 1 || leg.shareBp > FULL_BP) {
        throw new BankError('Each share is a whole number of basis points from 1 to 10000', 'bank.sorter_invalid');
      }
      total += leg.shareBp;
    }
    if (total > FULL_BP) {
      throw new BankError(`The shares total ${total / 100}%, more than 100% (bank.sorter_invalid)`, 'bank.sorter_invalid');
    }
    for (const leg of legs) await this.ownTargetSpace(input.userId, leg.spaceId, input.assetId);

    return this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${input.userId}), hashtext(${`sorter:${input.assetId}`}))`;
      const prior = await tx<SorterRow[]>`SELECT ${tx.unsafe(SORTER_COLS)} FROM bank.income_sorters WHERE id = ${input.sorterId}::uuid`;
      if (prior[0]) {
        const priorLegs = await tx<LegRow[]>`
          SELECT sorter_id, position, space_id, share_bp FROM bank.income_sorter_legs WHERE sorter_id = ${input.sorterId}::uuid
        `;
        const existing = toSorter(prior[0], priorLegs);
        if (existing.userId !== input.userId || existing.assetId !== input.assetId || !sameLegs(existing.legs, legs)) {
          throw new BankError(`Sorter ${input.sorterId} already exists on different terms`, 'bank.sorter_conflict');
        }
        return existing;
      }
      const live = await tx<Array<{ id: string }>>`
        SELECT id FROM bank.income_sorters WHERE user_id = ${input.userId} AND asset_id = ${input.assetId} AND status = 'active'
      `;
      if (live[0]) {
        throw new BankError(`This account already sorts ${input.assetId}; cancel that sorter first`, 'bank.sorter_exists');
      }
      const [row] = await tx<SorterRow[]>`
        INSERT INTO bank.income_sorters (id, user_id, asset_id, status)
        VALUES (${input.sorterId}::uuid, ${input.userId}, ${input.assetId}, 'active')
        RETURNING ${tx.unsafe(SORTER_COLS)}
      `;
      const inserted: LegRow[] = [];
      for (const [position, leg] of legs.entries()) {
        const [legRow] = await tx<LegRow[]>`
          INSERT INTO bank.income_sorter_legs (sorter_id, position, space_id, share_bp)
          VALUES (${input.sorterId}::uuid, ${position}, ${leg.spaceId}::uuid, ${leg.shareBp})
          RETURNING sorter_id, position, space_id, share_bp
        `;
        inserted.push(legRow!);
      }
      return toSorter(row!, inserted);
    });
  }

  /** Stop sorting. Credits already sorted stay where they went; a run still settling keeps its fixed splits. */
  async cancel(userId: string, sorterId: string, now: Date = new Date()): Promise<IncomeSorter> {
    const sorter = await this.own(userId, sorterId);
    if (sorter.status === 'cancelled') return sorter;
    await this.sql`
      UPDATE bank.income_sorters SET status = 'cancelled', cancelled_at = ${now}
       WHERE id = ${sorterId}::uuid AND status = 'active'
    `;
    return this.own(userId, sorterId);
  }

  /**
   * The account's live sorters, one per asset at most, each space named. A space archived since the sorter was made
   * says so: its splits are refused and its share stays in the account until the person changes the sorter.
   */
  async list(userId: string): Promise<ListedSorter[]> {
    const rows = await this.sql<SorterRow[]>`
      SELECT ${this.sql.unsafe(SORTER_COLS)} FROM bank.income_sorters
       WHERE user_id = ${userId} AND status = 'active'
       ORDER BY asset_id
    `;
    if (!rows.length) return [];
    const legs = await this.sql<Array<LegRow & { space_name: string; space_archived: boolean }>>`
      SELECT l.sorter_id, l.position, l.space_id, l.share_bp, sp.name AS space_name, sp.archived_at IS NOT NULL AS space_archived
        FROM bank.income_sorter_legs l
        JOIN bank.spaces sp ON sp.id = l.space_id
       WHERE l.sorter_id IN ${this.sql(rows.map((row) => row.id))}
    `;
    return rows.map((row) => ({
      ...toSorter(row, legs),
      spaces: Object.fromEntries(
        legs.filter((leg) => leg.sorter_id === row.id).map((leg) => [leg.space_id, { name: leg.space_name, archived: leg.space_archived }]),
      ),
    }));
  }

  /** What each sorted credit came to, newest first. Another person's sorter reads as not found. */
  async runs(userId: string, sorterId: string, limit: number): Promise<SorterRun[]> {
    await this.own(userId, sorterId);
    const rows = await this.sql<RunRow[]>`
      SELECT ${this.sql.unsafe(RUN_COLS)} FROM bank.income_sorter_runs
       WHERE sorter_id = ${sorterId}::uuid
       ORDER BY created_at DESC, id
       LIMIT ${limit}
    `;
    return this.withLegs(rows);
  }

  /**
   * Sort one posted credit. Called by the send that posted it and by the sweep; both are safe to repeat. A credit that
   * reaches a live sorter gets one run, ever: split into legs, or skipped with its reason when it is under the bank's
   * smallest sorted payment or no terms stand, so the sweep never weighs it again and never splits it later. A refused
   * split never throws: it is recorded `rejected` with its code and its share stays in the account.
   */
  async sortCredit(credit: IncomingCredit): Promise<SortOutcome> {
    return withMoneySpan(
      'bank.sorter.sort',
      { operation: 'income-sorter', amount: formatAmount(credit.amount), userId: credit.toUserId, assetId: credit.assetId },
      async () => {
        if (credit.fromUserId === credit.toUserId) return { status: 'unsorted', reason: 'own_money' };
        const existing = await this.runForCredit(credit.transferId);
        if (existing) return { status: 'recorded', run: await this.drive(existing, credit.toUserId) };

        const sorters = await this.sql<SorterRow[]>`
          SELECT ${this.sql.unsafe(SORTER_COLS)} FROM bank.income_sorters
           WHERE user_id = ${credit.toUserId} AND asset_id = ${credit.assetId} AND status = 'active'
             AND created_at <= ${credit.postedAt}
        `;
        const row = sorters[0];
        if (!row) return { status: 'unsorted', reason: 'no_sorter' };
        const legs = await this.sql<LegRow[]>`
          SELECT sorter_id, position, space_id, share_bp FROM bank.income_sorter_legs WHERE sorter_id = ${row.id}::uuid
        `;
        const sorter = toSorter(row, legs);
        const min = this.minimumCredit();
        const skipped: SorterSkip | null = min === null ? 'terms_unset' : credit.amount < min ? 'below_minimum' : null;

        const created = await this.sql.begin(async (tx) => {
          const [run] = await tx<RunRow[]>`
            INSERT INTO bank.income_sorter_runs (
              sorter_id, credit_transfer_id, credit_tx_id, credit_amount, credit_posted_at, skipped_reason
            ) VALUES (
              ${sorter.id}::uuid, ${credit.transferId}, ${credit.ledgerTxId}, ${formatAmount(credit.amount)}::numeric,
              ${credit.postedAt}, ${skipped}
            )
            ON CONFLICT (credit_transfer_id) DO NOTHING
            RETURNING ${tx.unsafe(RUN_COLS)}
          `;
          if (!run || skipped) return run ?? null;
          for (const [position, leg] of sorter.legs.entries()) {
            const share = legShare(credit.amount, leg.shareBp);
            if (share <= 0n) continue;
            await tx`
              INSERT INTO bank.income_sorter_run_legs (run_id, position, space_id, amount, status)
              VALUES (${run.id}::uuid, ${position}, ${leg.spaceId}::uuid, ${formatAmount(share)}::numeric, 'pending')
            `;
          }
          return run;
        });
        // Another path made this credit's run first: drive that one, never a second.
        const run = created ?? (await this.runForCredit(credit.transferId));
        if (!run) throw new BankError(`No sorter run for ${credit.transferId}`, 'bank.sorter_split_failed');
        return { status: 'recorded', run: await this.drive(run, credit.toUserId) };
      },
    );
  }

  /**
   * The sweep: record posted credits that reached a live sorter but have no run (the send crashed after its post), then
   * drive the splits still pending in runs older than a minute, least recently tried first, so a split that never
   * settles cannot keep the others waiting. A split still pending after a pass is logged for an operator.
   */
  async sweep(limit: number, now: Date = new Date()): Promise<SorterSweepReport> {
    const report: SorterSweepReport = { creditsRecorded: 0, runsDriven: 0, legsStillPending: 0 };
    const unsorted = await this.sql<
      Array<{
        transfer_id: string;
        from_user_id: string;
        to_user_id: string;
        asset_id: string;
        amount: string;
        ledger_tx_id: string;
        posted_at: Date;
      }>
    >`
      SELECT t.transfer_id, t.from_user_id, t.to_user_id, t.asset_id, t.amount::text AS amount, t.ledger_tx_id, t.posted_at
        FROM bank.income_sorters s
        JOIN bank.personal_transfers t
          ON t.to_user_id = s.user_id AND t.asset_id = s.asset_id AND t.status = 'posted' AND t.posted_at >= s.created_at
       WHERE s.status = 'active'
         AND t.from_user_id <> t.to_user_id
         AND NOT EXISTS (SELECT 1 FROM bank.income_sorter_runs r WHERE r.credit_transfer_id = t.transfer_id)
       ORDER BY t.posted_at
       LIMIT ${limit}
    `;
    for (const row of unsorted) {
      const outcome = await this.sortCredit({
        transferId: row.transfer_id,
        fromUserId: row.from_user_id,
        toUserId: row.to_user_id,
        assetId: row.asset_id,
        amount: parseAmount(row.amount),
        ledgerTxId: row.ledger_tx_id,
        postedAt: row.posted_at,
      });
      if (outcome.status === 'recorded') report.creditsRecorded += 1;
    }
    const before = new Date(now.getTime() - SWEEP_AFTER_MS);
    const pending = await this.sql<Array<RunRow & { user_id: string }>>`
      SELECT r.id, r.sorter_id, r.credit_transfer_id, r.credit_tx_id, r.credit_amount::text AS credit_amount,
             r.credit_posted_at, r.skipped_reason, r.created_at, s.user_id
        FROM bank.income_sorter_runs r
        JOIN bank.income_sorters s ON s.id = r.sorter_id
       WHERE r.created_at < ${before}
         AND EXISTS (SELECT 1 FROM bank.income_sorter_run_legs l WHERE l.run_id = r.id AND l.status = 'pending')
       ORDER BY r.driven_at NULLS FIRST, r.created_at
       LIMIT ${limit}
    `;
    for (const row of pending) {
      const run = await this.drive(row, row.user_id);
      report.runsDriven += 1;
      const stuck = run.legs.filter((leg) => leg.status === 'pending');
      report.legsStillPending += stuck.length;
      if (stuck.length) {
        console.error(
          JSON.stringify({
            level: 'error',
            service: 'svc-bank',
            event: 'bank.sorter_split_pending',
            runId: run.id,
            creditTxId: run.creditTxId,
            positions: stuck.map((leg) => leg.position),
          }),
        );
      }
    }
    return report;
  }

  /** Post every pending split of one run, in order, and answer the run as it now stands. */
  private async drive(run: RunRow, userId: string): Promise<SorterRun> {
    const [sorter] = await this.sql<
      SorterRow[]
    >`SELECT ${this.sql.unsafe(SORTER_COLS)} FROM bank.income_sorters WHERE id = ${run.sorter_id}::uuid`;
    const legs = await this.sql<RunLegRow[]>`
      SELECT ${this.sql.unsafe(RUN_LEG_COLS)} FROM bank.income_sorter_run_legs WHERE run_id = ${run.id}::uuid ORDER BY position
    `;
    const owed = legs.filter((leg) => leg.status === 'pending');
    for (const leg of owed) await this.driveLeg(run, sorter!.asset_id, userId, leg);
    if (owed.length) await this.sql`UPDATE bank.income_sorter_runs SET driven_at = now() WHERE id = ${run.id}::uuid`;
    const [settled] = await this.withLegs([run]);
    return settled!;
  }

  /**
   * One split: an own-space `bankTransfer` from the account into the space. A ledger in `detect` mode answers a reused
   * key with the original transaction; only this movement settles the split, anything else leaves it pending (unknown
   * outcome), as does a lost reply. The key is read first: a split whose earlier post landed settles on that booking,
   * whatever has happened to the spaces since, so a later archive can never mark moved money as not moved.
   *
   * With nothing under the key, the split claims an attempt (`attempted_at`) before it posts. While an earlier attempt
   * is younger than the ledger's in-flight bound, that post may still land, so the split is neither posted again nor
   * refused: it waits for a later sweep to read the key. Once claimed, a refusal before the post (an archived space, no
   * account) or a ledger refusal that proves this one attempt committed nothing (`provesPostNotCommitted`) rejects the
   * split with its code, and its share stays in the account.
   */
  private async driveLeg(run: RunRow, assetId: string, userId: string, leg: RunLegRow): Promise<void> {
    const now = new Date();
    const amount = parseAmount(leg.amount);
    const transferId = sorterTransferId(run.sorter_id, run.credit_tx_id);
    const settle = (ledgerTxId: string) => this.sql`
      UPDATE bank.income_sorter_run_legs
         SET status = 'settled', ledger_tx_id = ${ledgerTxId}, rejection_code = NULL, settled_at = ${now}
       WHERE run_id = ${run.id}::uuid AND position = ${leg.position} AND status = 'pending'
    `;
    const reject = (code: string) => this.sql`
      UPDATE bank.income_sorter_run_legs
         SET status = 'rejected', rejection_code = ${code}, settled_at = ${now}
       WHERE run_id = ${run.id}::uuid AND position = ${leg.position} AND status = 'pending'
    `;
    const booked = await this.ledger.getTxByKey(bankTransferKey('own', transferId, leg.position));
    if (booked) {
      // The account itself and the space, as `accountForSpace` names a primary and a named space.
      const matches = await bookedTransferMatches(
        this.ledger,
        booked,
        userAvailable(userId, assetId),
        subAccountAvailable(leg.space_id, assetId),
        amount,
      );
      if (matches) await settle(booked.id);
      return;
    }
    // On the database clock, in one statement, so two drivers never both post and neither reads its own claim as stale.
    const claimed = await this.sql`
      UPDATE bank.income_sorter_run_legs SET attempted_at = now()
       WHERE run_id = ${run.id}::uuid AND position = ${leg.position} AND status = 'pending'
         AND (attempted_at IS NULL OR attempted_at < now() - make_interval(secs => ${POST_IN_FLIGHT_BOUND_SECONDS}))
      RETURNING position
    `;
    if (!claimed.length) return;

    let fromAccount: ReturnType<typeof accountForSpace>;
    let toAccount: ReturnType<typeof accountForSpace>;
    try {
      const primary = await this.spaces.findPrimary(userId, assetId);
      if (!primary) throw new BankError(`No ${assetId} account to sort from`, 'bank.space_not_found');
      const from = await this.spaces.resolveForDebit(primary.id, now);
      const to = await this.spaces.resolveForCredit(leg.space_id, { actingUserId: userId });
      if (to.userId !== userId || to.kind !== 'named') throw new BankError(`Space ${leg.space_id} not found`, 'bank.space_not_found');
      if (to.assetId !== assetId) {
        throw new BankError(`Sorter asset ${assetId} does not match space asset ${to.assetId}`, 'bank.asset_mismatch');
      }
      fromAccount = accountForSpace(from);
      toAccount = accountForSpace(to);
    } catch (err) {
      // Nothing was posted by this attempt, and any earlier one is past the in-flight bound with nothing under the key.
      if (err instanceof BankError) await reject(err.code);
      return;
    }
    try {
      const tx = await this.ledger.post(
        recipes.bankTransfer({
          transferId,
          occurrence: leg.position,
          from: fromAccount,
          to: toAccount,
          amount,
          kind: 'manual',
          keySpace: 'own',
        }),
      );
      if (!(await bookedTransferMatches(this.ledger, tx, fromAccount, toAccount, amount))) return;
      await settle(tx.id);
    } catch (err) {
      if (provesPostNotCommitted(err)) await reject(legRefusalCode(err));
    }
  }

  private async runForCredit(transferId: string): Promise<RunRow | null> {
    const rows = await this.sql<RunRow[]>`
      SELECT ${this.sql.unsafe(RUN_COLS)} FROM bank.income_sorter_runs WHERE credit_transfer_id = ${transferId}
    `;
    return rows[0] ?? null;
  }

  private async withLegs(rows: RunRow[]): Promise<SorterRun[]> {
    if (!rows.length) return [];
    const legs = await this.sql<RunLegRow[]>`
      SELECT ${this.sql.unsafe(RUN_LEG_COLS)} FROM bank.income_sorter_run_legs
       WHERE run_id IN ${this.sql(rows.map((row) => row.id))}
    `;
    return rows.map((row) => toRun(row, legs));
  }

  /** The person's own sorter; another person's reads as not found. */
  private async own(userId: string, sorterId: string): Promise<IncomeSorter> {
    const rows = await this.sql<SorterRow[]>`SELECT ${this.sql.unsafe(SORTER_COLS)} FROM bank.income_sorters WHERE id = ${sorterId}::uuid`;
    const row = rows[0];
    if (!row || row.user_id !== userId) throw new BankError(`Sorter ${sorterId} not found`, 'bank.sorter_not_found');
    const legs = await this.sql<LegRow[]>`
      SELECT sorter_id, position, space_id, share_bp FROM bank.income_sorter_legs WHERE sorter_id = ${sorterId}::uuid
    `;
    return toSorter(row, legs);
  }

  /** One of the person's own live named spaces of `assetId`. The account itself keeps what is not sorted. */
  private async ownTargetSpace(userId: string, spaceId: string, assetId: string): Promise<void> {
    const space = await this.spaces.get(spaceId);
    if (space.userId !== userId) throw new BankError(`Space ${spaceId} not found`, 'bank.space_not_found');
    if (space.kind !== 'named') {
      throw new BankError('What is not sorted stays in the account, so the account itself is not a sorter space', 'bank.sorter_invalid');
    }
    if (space.archivedAt) throw new BankError(`Space "${space.name}" is archived`, 'bank.space_archived');
    if (space.assetId !== assetId) {
      throw new BankError(`Sorter asset ${assetId} does not match space asset ${space.assetId}`, 'bank.asset_mismatch');
    }
  }
}

/** `/internal/jobs/run-income-sorter`: how many credits, and how many runs with a pending split, one pass may take. */
export const incomeSorterBody = z.object({ limit: z.number().int().min(1).max(1000) }).strict();
