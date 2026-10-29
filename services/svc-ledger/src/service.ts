import type { Sql } from 'postgres';
import { recordOperatorAccess, type OperatorAccessEntry } from './ledger/operator-owner-balances.js';
import type { LookupActor } from './ledger/operator-lookup.js';
import {
  listOperatorTransactions,
  operatorAccountSearch,
  operatorTxList,
  readBookingRecord,
  readOperatorStats,
  searchOperatorAccounts,
  type BookingRecord,
  type DeskReader,
  type OperatorAccountSearchInput,
  type OperatorAccountSearchOutput,
  type OperatorStatsOutput,
  type OperatorTxListInput,
  type OperatorTxListOutput,
} from './ledger/operator-desk.js';
import { toWriteBlockError } from './ledger/write-block.js';
import { assessClockSkew, readDatabaseNow, sampleClocks, type ClockSkewView } from './ledger/clock-skew.js';
import {
  LedgerError,
  type AccountRef,
  type IdempotencyConflictOptions,
  type Balance,
  type LedgerClient,
  type LedgerTx,
  type PostRequest,
} from '@intafaced/ledger-client';
import type { EventBus, Payload } from '@intafaced/events';
import { PostgresLedger, type LedgerTxOutboxRow } from './ledger/postgres-ledger.js';
import {
  markFreezeOutboxPublished,
  readFreeze,
  unpublishedFreezeOutbox,
  writeFreeze,
  type FreezeOutboxRow,
  type FreezeState,
} from './ledger/freeze.js';
import type { RestoreWatermarkRead } from '@intafaced/contracts';
import type { ReconciliationEvaluationFeed } from '@intafaced/contracts/ledger-reconciliation';
import type { FeeRevenueRow } from './ledger/fee-revenue.js';
import type { HistoryEntry, HistoryPage, HistoryPageInput, HistoryRange } from './ledger/history.js';
import type { HoldingsHistory, HoldingsHistoryInput } from './ledger/holdings-history.js';
import {
  readLastVerified,
  countConsecutiveIncompleteRuns,
  runSnapshotReconciliation,
  type LastVerified,
  type ReconciliationReport,
  type ScheduledReconcileLedger,
} from './ledger/reconcile.js';
import { DEFAULT_RECONCILE_STATEMENT_TIMEOUT_MS, RECONCILE_ACTOR, RECONCILE_MISMATCH_REASON } from './ledger/reconcile-config.js';
import type { ReconcileIncompleteAlert } from './ledger/scheduled-reconcile-tick.js';
import { withMoneySpan, withSpan } from './tracing.js';
import type { RegistryAsset } from '@intafaced/contracts';
import type { ActionApprovalConsumer } from './ledger/action-approval-consume.js';
import {
  deleteAccountMetadata,
  operatorAccountMetadataRead,
  readAccountMetadata,
  setAccountMetadata,
  type AccountMetadataChangeOutput,
  type AccountMetadataOutput,
  type AccountMetadataReadInput,
} from './ledger/operator-account-metadata.js';
import { applyAssetEdit, getAsset, listAssets, listOperatorAssets, type OperatorAssetRow } from './ledger/supported-assets.js';
import {
  listReconciliationEvaluations,
  type ReconciliationSources,
  runDueReconciliationControls as runDueOperatorControls,
  unsetReconciliationSources,
} from './ledger/reconciliation-controls.js';

/**
 * The service layer: the ledger engine plus the three things wrapping every
 * post — the freeze switch, tracing, and the event emission that lets the rest
 * of the OS react to money moving.
 *
 * The freeze switch OWNS no state. It reads and writes `posting_freeze`, and
 * `post()` is gated inside the engine's chain-tip transaction rather than here
 * (see postgres-ledger.ts). Clock skew is the same gate: a committed key is
 * answered before a new write is refused. This class holds no cached copy on
 * purpose: a cache would be right until the moment a second replica moved the
 * switch, which is exactly the moment it matters.
 */
export class LedgerService implements LedgerClient, ScheduledReconcileLedger {
  private readonly engine: PostgresLedger;
  private readonly bootPostingEnabled: boolean;
  private readonly reconcileStatementTimeoutMs: number;
  private readonly clockSkewBoundMs: number | null;
  private readonly now: () => Date;
  private readonly readDatabaseNow: (sql: Sql) => Promise<Date>;
  private readonly reconciliationSources: ReconciliationSources;

  constructor(
    private readonly sql: Sql,
    private readonly bus: EventBus,
    options: {
      postingEnabled?: boolean;
      reconcileStatementTimeoutMs?: number;
      /** Null or omitted: the owner has not set a bound. Not zero. */
      clockSkewBoundMs?: number | null;
      now?: () => Date;
      readDatabaseNow?: (sql: Sql) => Promise<Date>;
      /** The outside and parity sides operator controls read; omitted, both are unset. */
      reconciliationSources?: ReconciliationSources;
    } & IdempotencyConflictOptions = {},
  ) {
    this.bootPostingEnabled = options.postingEnabled ?? true;
    this.reconcileStatementTimeoutMs = options.reconcileStatementTimeoutMs ?? DEFAULT_RECONCILE_STATEMENT_TIMEOUT_MS;
    this.clockSkewBoundMs = options.clockSkewBoundMs ?? null;
    this.now = options.now ?? (() => new Date());
    this.readDatabaseNow = options.readDatabaseNow ?? readDatabaseNow;
    this.reconciliationSources = options.reconciliationSources ?? unsetReconciliationSources();
    this.engine = new PostgresLedger(sql, {
      ...(options.idempotencyConflict ? { idempotencyConflict: options.idempotencyConflict } : {}),
      onIdempotencyMismatch:
        options.onIdempotencyMismatch ??
        ((info) =>
          // One greppable line per mismatch: the alert for "a job re-ran under a booked key with a different body".
          console.warn(JSON.stringify({ level: 'warn', service: 'svc-ledger', event: 'ledger.idempotency_mismatch', ...info }))),
      clockSkewBoundMs: this.clockSkewBoundMs,
      now: this.now,
      readDatabaseNow: this.readDatabaseNow,
    });
  }

  /**
   * App clock against `clock_timestamp()`. A blank bound refuses here. It does
   * not block posts: that would be the same as inventing a bound of 0.
   */
  async clockSkew(): Promise<ClockSkewView> {
    return assessClockSkew({
      boundMs: this.clockSkewBoundMs,
      ...(await sampleClocks(this.now, () => this.readDatabaseNow(this.sql))),
    });
  }

  async post(request: PostRequest): Promise<LedgerTx> {
    return withMoneySpan(
      'ledger.post',
      {
        module: request.module,
        reason: request.reason,
        idempotencyKey: request.idempotencyKey,
        entryCount: request.entries.length,
      },
      async (span) => {
        let tx: LedgerTx;
        try {
          tx = await this.engine.post(request);
        } catch (err) {
          throw toWriteBlockError(err);
        }
        span.setAttribute('intafaced.tx_id', tx.id);

        // Publish AFTER commit, from the outbox row written in that same
        // transaction. A consumer must never see a tx that could still roll
        // back; a crash here leaves the row unpublished for boot/tick recover.
        await this.publishUnpublishedOutbox({ txId: tx.id });

        return tx;
      },
    );
  }

  balance(ref: AccountRef): Promise<Balance> {
    return this.engine.balance(ref);
  }

  balances(ownerType: AccountRef['ownerType'], ownerId: string): Promise<Balance[]> {
    return this.engine.balances(ownerType, ownerId);
  }

  /** Operator access row for the ledger desk (0024, 0026). Written before an operator reads an owner's detail or one transaction. */
  recordOperatorAccess(entry: OperatorAccessEntry): Promise<void> {
    return recordOperatorAccess(this.sql, entry);
  }

  /**
   * Entry history for one account in one window — a READ, and nothing else.
   *
   * Deliberately NOT on the `LedgerClient` interface, for the same reason
   * `freeze` is not: `LedgerClient` is what every calling service codes against
   * and what the conformance suite pins, and this is one caller's projection
   * source rather than a capability every ledger implementation must offer.
   *
   * No span wrapper, matching `balance`/`balances`. `withMoneySpan` exists to
   * keep MOVEMENTS at 100% through the tail sampler; nothing moves here, and
   * tagging a read `money_path=true` would dilute the one signal that decides
   * what the collector keeps.
   */
  history(ref: AccountRef, range: HistoryRange): Promise<HistoryEntry[]> {
    return this.engine.history(ref, range);
  }

  /** Fee revenue per asset over one window. A read; same no-span reasoning as `history`. */
  feeRevenue(range: HistoryRange): Promise<FeeRevenueRow[]> {
    return this.engine.feeRevenue(range);
  }

  /** Finished reconciliation evaluations after a cursor, for svc-ops' alert store (OPS-reconciliation-03). A read. */
  async reconciliationEvaluations(input: unknown): Promise<ReconciliationEvaluationFeed> {
    return listReconciliationEvaluations(this.sql, input);
  }

  /** The ledger's position for the joint restore. A read; same no-span reasoning as `history`. */
  async restoreWatermark(): Promise<RestoreWatermarkRead> {
    const at = await this.engine.restoreWatermark();
    return {
      service: 'ledger',
      kind: 'chain_tip.seq',
      position: at.position,
      integrity: at.integrity,
      lastWriteAt: at.lastWriteAt ? at.lastWriteAt.toISOString() : null,
      readAt: new Date().toISOString(),
    };
  }

  /** The published asset and network registry (W-balances-05). A read: no chain tip, no balance. */
  listAssets(input?: unknown): Promise<RegistryAsset[]> {
    return listAssets(this.sql, input);
  }

  getAsset(input: unknown): Promise<RegistryAsset> {
    return getAsset(this.sql, input);
  }

  /** Every registry row, published or not, for the operator console. */
  listOperatorAssets(): Promise<OperatorAssetRow[]> {
    return listOperatorAssets(this.sql);
  }

  /** One founder edit, approved through identity, applied once per operation id. Moves no value. */
  applyAssetEdit(approvals: ActionApprovalConsumer, operatorId: string, input: unknown): Promise<RegistryAsset> {
    return applyAssetEdit(this.sql, approvals, operatorId, input);
  }

  /** What one owner holds now and how it moved since a point in time (J-portfolio-05). A read; same no-span reasoning. */
  holdingsHistory(input: HoldingsHistoryInput): Promise<HoldingsHistory> {
    return this.engine.holdingsHistory(input);
  }

  /** Paged sibling of `history`. A read; same no-span reasoning. */
  historyPage(input: HistoryPageInput): Promise<HistoryPage> {
    return this.engine.historyPage(input);
  }

  getTx(txId: string): Promise<LedgerTx | null> {
    return this.engine.getTx(txId);
  }

  getTxByKey(idempotencyKey: string): Promise<LedgerTx | null> {
    return this.engine.getTxByKey(idempotencyKey);
  }

  /** The booking record beside one transaction (OPS-ledger-desk-01). A read; callers record the lookup first. */
  readBookingRecord(txId: string): Promise<BookingRecord | null> {
    return readBookingRecord(this.sql, txId);
  }

  /**
   * The ledger desk's list and address search (OPS-ledger-desk-01). Each writes its access row before it reads and
   * refuses when it cannot, here, so every door that serves them inherits the record. Reads; same no-span reasoning.
   */
  deskTransactions(actor: LookupActor, input: OperatorTxListInput): Promise<OperatorTxListOutput> {
    return operatorTxList(this.deskReader(), actor, input);
  }

  deskAccounts(actor: LookupActor, input: OperatorAccountSearchInput): Promise<OperatorAccountSearchOutput> {
    return operatorAccountSearch(this.deskReader(), actor, input);
  }

  private deskReader(): DeskReader {
    return {
      recordOperatorAccess: (entry) => this.recordOperatorAccess(entry),
      readTransactionPage: (input) => listOperatorTransactions(this.sql, input),
      readAccountPage: (input) => searchOperatorAccounts(this.sql, input),
    };
  }

  /**
   * An account's operator metadata (J-ops-console-03 #6, #7). The read is recorded first, like the desk's other reads.
   * A set is one founder's; a delete spends a second founder's approval. Both refuse `ledger.frozen` under the freeze.
   */
  deskAccountMetadata(actor: LookupActor, input: AccountMetadataReadInput): Promise<AccountMetadataOutput> {
    return operatorAccountMetadataRead(
      { recordOperatorAccess: (entry) => this.recordOperatorAccess(entry), readAccountMetadata: (i) => readAccountMetadata(this.sql, i) },
      actor,
      input,
    );
  }

  setAccountMetadata(actorId: string, input: unknown): Promise<AccountMetadataChangeOutput> {
    return setAccountMetadata(this.sql, actorId, input);
  }

  deleteAccountMetadata(approvals: ActionApprovalConsumer, operatorId: string, input: unknown): Promise<AccountMetadataChangeOutput> {
    return deleteAccountMetadata(this.sql, approvals, operatorId, input);
  }

  /** The book's counts. Names no one, so no access row. */
  readOperatorStats(): Promise<OperatorStatsOutput> {
    return readOperatorStats(this.sql);
  }

  journal(limit?: number, afterSeq?: bigint): Promise<LedgerTx[]> {
    return this.engine.journal(limit, afterSeq);
  }

  // ── Operator controls (§14 admin) ──────────────────────────────────────────
  //
  // Deliberately NOT on the `LedgerClient` interface, and so not in the
  // conformance suite. `LedgerClient` is the contract every calling service
  // codes against; widening it would give svc-trade a method to halt the
  // platform, and the in-memory reference a durability guarantee it cannot
  // honour. Freezing is an operator action against THE ledger, not a thing a
  // ledger client does.

  /**
   * Halt posting, durably.
   *
   * `actor` is required and unvalidated on purpose: an operator's principal id,
   * `reconciliation`, or `env:LEDGER_POSTING_ENABLED`. The database refuses a
   * freeze with neither reason nor actor (`posting_freeze_attributed_ck`) —
   * whoever finds the platform halted must be able to find out why and by whom.
   *
   * Same-attribution re-freeze is a true no-op of the switch (hourly recon: no
   * `changed_at` bump). Different attribution while already frozen **throws**
   * `ledger.freeze_attributed` — the first reason stays, and the caller must not
   * be told their freeze applied (operator HTTP → 409). Recon catches that code
   * so an operator halt is never clobbered and the alarm still pages.
   *
   * The `ledgerFreezeUpdated` intent commits with the switch. Publish runs
   * after that, from the unpublished outbox row. A bus throw leaves the row,
   * so a later call with the same reason and actor emits it and does not move
   * the switch again. A true no-op — state unchanged and nothing pending —
   * publishes nothing.
   */
  async freeze(reason: string, actor: string): Promise<FreezeState> {
    const { state } = await writeFreeze(this.sql, { frozen: true, reason, actor });
    await this.publishUnpublishedFreezeOutbox();
    return state;
  }

  /**
   * Thaw posting. `actor` alone does not clear a freeze. `confirmOperatorId`
   * is the other person, taken from a consumed approval, and must be distinct
   * from `actor` and from the actor who froze the book. An already-open book
   * stays a no-op so a second clear does not rewrite the row.
   */
  async unfreeze(actor: string, confirmOperatorId?: string | null): Promise<FreezeState> {
    const { state } = await writeFreeze(this.sql, { frozen: false, actor, confirmOperatorId });
    await this.publishUnpublishedFreezeOutbox();
    return state;
  }

  /**
   * What the DATABASE says, every time — no cached field.
   *
   * A round trip per `/health` and `/ready` call, accepted: a single-row
   * primary-key read is cheap, and the alternative is a replica reporting
   * itself ready while the book it writes to is frozen. That is the exact
   * failure this change exists to remove.
   */
  async status(): Promise<{ postingEnabled: boolean; frozenReason: string | null; frozenBy: string | null }> {
    const state = await readFreeze(this.sql);
    return { postingEnabled: !state.frozen, frozenReason: state.reason, frozenBy: state.actor };
  }

  /**
   * The whole freeze row, for the operator surface.
   *
   * `status()` reshapes it for health checks and drops `changedAt`. An operator
   * deciding whether to thaw needs to know WHEN the platform was halted as much
   * as by whom — a freeze from four minutes ago and one from yesterday call for
   * different actions — so the operator read returns the row rather than the
   * health projection of it.
   */
  async freezeState(): Promise<FreezeState> {
    return readFreeze(this.sql);
  }

  /**
   * Reconcile `LEDGER_POSTING_ENABLED` with the database at boot. Call once,
   * before serving traffic.
   *
   * THE DATABASE WINS — but only in one direction, and the asymmetry is the
   * whole safety property:
   *
   *   · `LEDGER_POSTING_ENABLED=false` FREEZES. The flag is a legitimate way to
   *     bring the platform up halted, and making it durable means that decision
   *     also reaches the replica whose config nobody edited.
   *
   *   · `LEDGER_POSTING_ENABLED=true` NEVER THAWS. It defaults to true, so
   *     honouring it would mean any restart of any replica — a deploy, an OOM
   *     kill, an autoscaler — silently resumes posting on a book that
   *     reconciliation halted. That is precisely the bug this change removes,
   *     and it would come straight back through the front door.
   *
   * An unfreeze is a deliberate act with a named actor. A default-valued
   * environment variable is not one, and must never be able to impersonate one.
   */
  async applyStartupPolicy(): Promise<FreezeState> {
    const state = await readFreeze(this.sql);
    if (this.bootPostingEnabled || state.frozen) return state;

    return this.freeze('LEDGER_POSTING_ENABLED=false at startup', 'env:LEDGER_POSTING_ENABLED');
  }

  /**
   * Publish unpublished `ledgerTxPosted` and `ledgerFreezeUpdated` intents,
   * then mark them sent.
   *
   * Boot and the outbox tick call this. It is NOT part of `applyStartupPolicy`
   * — that path is freeze-only and must not grow identity (or any other)
   * side effects. Freeze publish failure is recovered here too: the switch
   * commits with its outbox row, and this drain emits that row without
   * writing `posting_freeze` again.
   */
  async recoverUnpublishedOutbox(): Promise<number> {
    let published = 0;
    for (let i = 0; i < 20; i++) {
      const n = await this.publishUnpublishedOutbox();
      const freeze = await this.publishUnpublishedFreezeOutbox();
      published += n + freeze;
      if (n === 0 && freeze === 0) break;
    }
    return published;
  }

  private async publishUnpublishedOutbox(opts: { txId?: string } = {}): Promise<number> {
    const rows = await this.engine.unpublishedOutbox(opts);
    for (const row of rows) {
      await this.bus.publish('ledgerTxPosted', ledgerTxPostedPayload(row), {
        idempotencyKey: `ledger.tx:${row.tx_id}`,
        correlationId: row.correlation_id,
      });
      await this.engine.markOutboxPublished(row.id);
    }
    return rows.length;
  }

  /**
   * Publish unpublished freeze intents, then mark them sent.
   *
   * Same order as `ledgerTxPosted`: the row is already committed, the bus
   * accepts, then `published_at` moves. A throw here leaves the row. The
   * idempotency key is the one stored with the switch (`freezeEventKey`),
   * not a key rebuilt from `changedAt`.
   */
  private async publishUnpublishedFreezeOutbox(): Promise<number> {
    const rows = await unpublishedFreezeOutbox(this.sql);
    for (const row of rows) {
      const event = ledgerFreezeUpdatedPayload(row);
      await this.bus.publish('ledgerFreezeUpdated', event.payload, { idempotencyKey: event.idempotencyKey });
      await markFreezeOutboxPublished(this.sql, row.id);
    }
    return rows.length;
  }

  /**
   * Run reconciliation. A completed mismatch freezes the ledger. A balance
   * drift also pages — §4.2: "mismatch = page the operator, freeze the
   * module that diverged". A chain break or an unbalanced asset is not that
   * page: freeze, and do not describe a zero drift on an account that does not
   * exist. An error that has not proved the book wrong does not freeze here.
   *
   * Same proof as the scheduled job: one REPEATABLE READ snapshot on its own
   * connection, no `chain_tip` lock, per-run `statement_timeout`. Live posts
   * therefore neither wait for it nor make it report a false `ok: false`.
   *
   * Anything other than a completed mismatch is incomplete. This call throws
   * `ledger.reconcile_incomplete` and freezes nothing. The scheduled tick, not
   * this call, freezes after N consecutive incomplete runs (`reconcile_unproven`),
   * using the larger of this process's count and the durable streak.
   *
   * The freeze is written BEFORE the page, and awaited. If the bus is down,
   * a real drift's alarm fails to send and this throws — with the book already
   * halted. An alarm nobody receives is bad; a book still accepting writes
   * because the alarm failed would be the actual disaster.
   */
  async reconcile(): Promise<ReconciliationReport> {
    return withSpan('ledger.reconcile', async () => {
      const run = await runSnapshotReconciliation(this.sql, { statementTimeoutMs: this.reconcileStatementTimeoutMs });

      if (run.outcome === 'skipped') {
        throw new LedgerError('a reconciliation is already running — try again when it has finished', 'ledger.reconcile_in_progress');
      }
      if (run.outcome === 'incomplete') {
        throw new LedgerError(
          `reconciliation could not finish (${run.errorCode}) — the book was NOT frozen and is NOT verified; see INCIDENT-MONEY-PATH-RUNBOOK "reconcile incomplete"`,
          'ledger.reconcile_incomplete',
        );
      }
      if (run.outcome === 'mismatch') await this.handleReconciliationMismatch(run.report);
      return run.report;
    });
  }

  /**
   * A completed failed proof already committed its halt with the mismatch run.
   * Retry that freeze for the fallback where recording failed, publish the
   * committed freeze intent, then emit the drift event.
   *
   * Prefer a freeze under actor `reconciliation`. If an operator already halted
   * the book, writeFreeze refuses the overwrite (STOP §4.2b #3) — catch that
   * only and leave their reason standing. Any other freeze error must surface
   * (raced / uninitialised). The freeze is already durable before a page is
   * attempted.
   */
  async handleReconciliationMismatch(report: ReconciliationReport): Promise<void> {
    try {
      await this.freeze(RECONCILE_MISMATCH_REASON, RECONCILE_ACTOR);
    } catch (err) {
      if (!(err instanceof LedgerError && err.code === 'ledger.freeze_attributed')) throw err;
    }
    await this.publishReconciliationDrift(report);
  }

  /**
   * Announce one incomplete run. The scheduled tick calls this on every
   * unfinished proof, including a TLS failure, a code-less error, and the run
   * that then freezes for `reconcile_unproven`. No subscriber is wired; the
   * event is the record.
   */
  async alertReconciliationIncomplete(alert: ReconcileIncompleteAlert): Promise<void> {
    await this.bus.publish(
      'ledgerReconciliationRunFailed',
      {
        errorCode: alert.errorCode,
        phase: alert.phase,
        consecutiveIncomplete: alert.consecutiveIncomplete,
        runId: alert.runId,
      },
      {
        idempotencyKey: `ledger.reconcile.incomplete:${alert.phase}:${alert.runId ?? 'unrecorded'}:${alert.consecutiveIncomplete}:${alert.errorCode}`,
      },
    );
  }

  /** When the book was last proved consistent. Backs `/health`, staleness reporting and the metric. */
  lastVerified(): Promise<LastVerified> {
    return readLastVerified(this.sql);
  }

  /**
   * Incomplete runs after the latest ok or mismatch. Survives a process restart.
   * An operator thaw does not write ok or mismatch, so it does not reset this.
   */
  consecutiveIncompleteRuns(): Promise<number> {
    return countConsecutiveIncompleteRuns(this.sql);
  }

  /** Due operator controls. Read-only: a failure does not freeze posting. */
  runDueReconciliationControls(): Promise<void> {
    return runDueOperatorControls(this.sql, this.reconciliationSources);
  }

  private async publishReconciliationDrift(report: ReconciliationReport): Promise<void> {
    const firstDrift = report.balances.ok ? null : report.balances.drift[0];
    if (!firstDrift) return;
    await this.bus.publish('ledgerReconciliationFailed', {
      accountId: firstDrift.accountId,
      assetId: firstDrift.assetId,
      snapshotBalance: firstDrift.cached,
      replayBalance: firstDrift.replayed,
      drift: firstDrift.difference,
      module: 'ledger',
    });
  }
}

function ledgerFreezeUpdatedPayload(row: FreezeOutboxRow): {
  payload: Payload<'ledgerFreezeUpdated'>;
  idempotencyKey: string;
} {
  const payload = row.payload;
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new LedgerError(`ledger_freeze_outbox ${row.id} payload is not an object`, 'ledger.outbox_payload');
  }
  refuseFreezeJsonNumber(payload, row.id);
  const body = payload as Record<string, unknown>;
  if (typeof body.frozen !== 'boolean') {
    throw new LedgerError(`ledger_freeze_outbox ${row.id} frozen must be a boolean`, 'ledger.outbox_payload');
  }
  if (typeof body.actor !== 'string' || body.actor.length === 0) {
    throw new LedgerError(`ledger_freeze_outbox ${row.id} actor must be a non-empty string`, 'ledger.outbox_payload');
  }
  if (typeof body.changedAt !== 'string' || body.changedAt.length === 0) {
    throw new LedgerError(`ledger_freeze_outbox ${row.id} changedAt must be a string`, 'ledger.outbox_payload');
  }
  const reason = body.reason;
  if (body.frozen) {
    if (typeof reason !== 'string' || reason.length === 0) {
      throw new LedgerError(`ledger_freeze_outbox ${row.id} freeze reason must be a non-empty string`, 'ledger.outbox_payload');
    }
  } else if (reason !== null) {
    throw new LedgerError(`ledger_freeze_outbox ${row.id} thaw reason must be null`, 'ledger.outbox_payload');
  }
  const idempotencyKey = row.idempotency_key;
  if (!idempotencyKey.startsWith('ledger.freeze:') || idempotencyKey.length <= 'ledger.freeze:'.length) {
    throw new LedgerError(`ledger_freeze_outbox ${row.id} idempotency key is not a freeze event key`, 'ledger.outbox_payload');
  }
  return {
    payload: {
      frozen: body.frozen,
      reason: body.frozen ? reason : null,
      actor: body.actor,
      changedAt: body.changedAt,
    },
    idempotencyKey,
  };
}

function refuseFreezeJsonNumber(value: unknown, id: string): void {
  if (typeof value === 'number') {
    throw new LedgerError(`ledger_freeze_outbox ${id} payload contains a JSON number`, 'ledger.outbox_payload');
  }
  if (Array.isArray(value)) {
    for (const item of value) refuseFreezeJsonNumber(item, id);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) refuseFreezeJsonNumber(item, id);
  }
}

function ledgerTxPostedPayload(row: LedgerTxOutboxRow): Payload<'ledgerTxPosted'> {
  const payload = row.payload;
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new LedgerError(`ledger_tx_outbox ${row.id} payload is not an object`, 'ledger.outbox_payload');
  }
  const entries = (payload as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) {
    throw new LedgerError(`ledger_tx_outbox ${row.id} payload.entries is not an array`, 'ledger.outbox_payload');
  }
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') {
      throw new LedgerError(`ledger_tx_outbox ${row.id} has a non-object entry`, 'ledger.outbox_payload');
    }
    const amount = (entry as { amount?: unknown }).amount;
    if (typeof amount === 'number') {
      throw new LedgerError(`ledger_tx_outbox ${row.id} amount arrived as a JS number`, 'ledger.outbox_payload');
    }
    if (typeof amount !== 'string') {
      throw new LedgerError(`ledger_tx_outbox ${row.id} amount must be a decimal string`, 'ledger.outbox_payload');
    }
  }
  return payload as Payload<'ledgerTxPosted'>;
}
