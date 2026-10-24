import postgres, { type Sql, type TransactionSql } from 'postgres';

type ReconciliationDb = Sql | TransactionSql;
import { formatAmount, LedgerError } from '@intafaced/ledger-client';
import { parseStoredAmount } from './live-money.js';
import { writeFreezeInTransaction } from './freeze.js';
import { RECONCILE_ACTOR, RECONCILE_MISMATCH_REASON } from './reconcile-config.js';
import { hashTx } from './postgres-ledger.js';
import { DEFAULT_RECONCILE_STATEMENT_TIMEOUT_MS, validReconcileStatementTimeoutMs } from './reconcile-config.js';

/**
 * RECONCILIATION (§4.2).
 *
 *   "Reconciliation job: snapshots vs. entry replay must match to 18 decimals;
 *    mismatch = page the operator, freeze the module that diverged."
 *
 * Three independent checks, each capable of catching a class of failure the
 * others cannot:
 *
 *   · `reconcileBalances` — the cached `accounts.balance` against a full replay
 *     of `ledger_entries`. Catches a bug in the posting path.
 *   · `verifyChain` — every hash recomputed from its predecessor, then
 *     `chain_tip.hash` against the last row. Catches tampering, including by
 *     someone with database access. A linked tail is not a healthy chain when
 *     the tip names a different hash.
 *   · `totalsByAsset` — every asset must net to zero across all accounts.
 *     Catches value being created or destroyed by any means at all.
 *
 * Operator-defined controls sit beside these three (reconciliation-controls.ts).
 * They do not post and they do not freeze the book.
 */

/**
 * A stored amount that cannot be read as numeric(38,18): NaN, infinity, or a
 * magnitude past the column (a replay or asset total that overflowed). That is
 * tampered or corrupted book data, not an unfinished proof.
 */
class CorruptReconcileAmountError extends LedgerError {
  constructor(readonly field: string) {
    super(`stored amount in ${field} cannot be parsed`, 'ledger.persisted_amount_corrupt');
  }
}

/** `chain_tip.seq` or `chain_tip.hash` arrived as something other than text. The shape itself is corrupt. */
class CorruptChainTipError extends LedgerError {
  constructor() {
    super('chain_tip arrived as a non-text value — refusing to anchor a snapshot on it', 'ledger.chain_tip_corrupt');
  }
}

function parseReconcileAmount(value: unknown, field: string): ReturnType<typeof parseStoredAmount> {
  try {
    return parseStoredAmount(value, field);
  } catch {
    throw new CorruptReconcileAmountError(field);
  }
}

export interface Drift {
  readonly accountId: string;
  readonly assetId: string;
  readonly cached: string;
  readonly replayed: string;
  readonly difference: string;
}

export type ReconcileResult = { ok: true; accountsChecked: number } | { ok: false; drift: Drift[]; accountsChecked: number };

export async function reconcileBalances(sql: ReconciliationDb): Promise<ReconcileResult> {
  // One pass, in the database: replaying millions of entries in Node would be
  // both slower and a memory problem.
  const rows = await sql<Array<{ account_id: string; asset_id: string; cached: string; replayed: string }>>`
    SELECT a.id                                        AS account_id,
           a.asset_id                                  AS asset_id,
           a.balance                                   AS cached,
           COALESCE(SUM(
             CASE WHEN e.direction = 'debit' THEN e.amount ELSE -e.amount END
           ), 0)                                       AS replayed
      FROM accounts a
      LEFT JOIN ledger_entries e ON e.account_id = a.id
     GROUP BY a.id, a.asset_id, a.balance
  `;

  const drift: Drift[] = [];
  for (const row of rows) {
    const cached = parseReconcileAmount(row.cached, 'accounts.balance');
    const replayed = parseReconcileAmount(row.replayed, 'ledger_entries.amount');
    if (cached !== replayed) {
      drift.push({
        accountId: row.account_id,
        assetId: row.asset_id,
        cached: formatAmount(cached),
        replayed: formatAmount(replayed),
        difference: formatAmount(cached - replayed),
      });
    }
  }

  return drift.length === 0 ? { ok: true, accountsChecked: rows.length } : { ok: false, drift, accountsChecked: rows.length };
}

export type ChainResult = { ok: true; length: number } | { ok: false; brokenAt: string; length: number };

/** One `ledger_entries` row as the chain proof reads it. Amounts stay decimal strings. */
interface ChainEntryRow {
  tx_id: string;
  account_id: string;
  asset_id: string;
  direction: 'debit' | 'credit';
  amount: string;
  balance_after: string;
}

export async function verifyChain(sql: ReconciliationDb, batchSize = 1000, asOf?: Date): Promise<ChainResult> {
  let previous: string | null = null;
  let lastId: string | null = null;
  let afterSeq = '0';
  let length = 0;

  for (;;) {
    const txs = await sql<
      Array<{
        id: string;
        seq: string;
        module: string;
        reason: string;
        posted_at: Date;
        hash: string;
        previous_hash: string | null;
        idempotency_key: string;
        meta: unknown;
        claim_matches: boolean;
      }>
    >`
      SELECT t.id, t.seq, t.module, t.reason, t.posted_at, t.hash, t.previous_hash, t.idempotency_key, t.meta,
             (k.idempotency_key IS NOT DISTINCT FROM t.idempotency_key
              AND k.posted_hash IS NOT DISTINCT FROM t.hash
              AND k.posted_meta IS NOT DISTINCT FROM t.meta) AS claim_matches
        FROM ledger_tx t
        LEFT JOIN ledger_posted_keys k ON k.tx_id = t.id
       WHERE t.seq > ${afterSeq}
         AND (${asOf ?? null}::timestamptz IS NULL OR t.posted_at <= ${asOf ?? null}::timestamptz)
       ORDER BY t.seq ASC
       LIMIT ${batchSize}
    `;
    if (txs.length === 0) break;

    // One read for this page. The hourly proof used to ask for entries once
    // per transaction inside the seq loop.
    const pageEntries = await sql<ChainEntryRow[]>`
      SELECT tx_id, account_id, asset_id, direction, amount, balance_after
        FROM ledger_entries
       WHERE tx_id = ANY(${txs.map((tx) => tx.id)}::uuid[])
       ORDER BY id ASC
    `;
    const entriesByTx = new Map<string, ChainEntryRow[]>();
    for (const tx of txs) entriesByTx.set(tx.id, []);
    for (const row of pageEntries) {
      const bucket = entriesByTx.get(row.tx_id);
      if (bucket) bucket.push(row);
    }

    for (const tx of txs) {
      const entries: ChainEntryRow[] = entriesByTx.get(tx.id) ?? [];

      // A row that cannot be parsed or hashed is a broken link. `posted_at` of
      // `infinity` makes `toISOString` throw RangeError; an amount that does not
      // fit numeric(38,18) throws while parsing. Either one is tampering, not
      // a proof that failed to finish. The page query itself is outside this
      // try: a statement timeout there is still incomplete.
      let legacy: string;
      try {
        const posted = {
          id: tx.id,
          module: tx.module,
          reason: tx.reason,
          postedAt: tx.posted_at,
          entries: entries.map((e) => ({
            id: '',
            txId: tx.id,
            accountId: e.account_id,
            assetId: e.asset_id,
            direction: e.direction,
            amount: parseReconcileAmount(e.amount, 'ledger_entries.amount'),
            balanceAfter: parseReconcileAmount(e.balance_after, 'ledger_entries.balance_after'),
          })),
        };
        // Claims copy the actual key, hash, and metadata at insert or upgrade.
        // A missing or contradictory claim refuses even though the shared digest
        // intentionally does not cover key/metadata. Historical hashes stay intact.
        if (!tx.claim_matches) {
          return { ok: false, brokenAt: tx.id, length };
        }
        legacy = hashTx(posted, previous);
      } catch {
        return { ok: false, brokenAt: tx.id, length };
      }

      if (tx.previous_hash !== previous || tx.hash !== legacy) {
        return { ok: false, brokenAt: tx.id, length };
      }

      previous = tx.hash;
      lastId = tx.id;
      afterSeq = tx.seq;
      length++;
    }
  }

  // A past instant proves the prefix committed by then. Later rows must still link to it.
  // The live tip is only required when nothing was posted after that instant.
  if (asOf) {
    const later = await sql<Array<{ previous_hash: string | null }>>`
      SELECT previous_hash FROM ledger_tx WHERE posted_at > ${asOf} ORDER BY seq ASC LIMIT 1
    `;
    if (later.length > 0) {
      if ((later[0]?.previous_hash ?? null) !== previous) {
        return { ok: false, brokenAt: lastId ?? 'chain_tip', length };
      }
      return { ok: true, length };
    }
  }

  // The singleton tip must name the last row by both sequence and hash.
  const tipRows = await sql<Array<{ hash: string | null; seq: string }>>`
    SELECT hash, seq::text AS seq FROM chain_tip WHERE id = true
  `;
  const tipHash = tipRows[0]?.hash ?? null;
  if (tipRows.length === 0 || tipHash !== previous || tipRows[0]?.seq !== afterSeq) {
    return { ok: false, brokenAt: lastId ?? 'chain_tip', length };
  }

  return { ok: true, length };
}

/** Every asset must sum to exactly zero across every account. */
export async function totalsByAsset(sql: ReconciliationDb): Promise<Record<string, string>> {
  const rows = await sql<Array<{ asset_id: string; total: string }>>`
    SELECT asset_id, COALESCE(SUM(balance), 0) AS total FROM accounts GROUP BY asset_id
  `;
  return Object.fromEntries(rows.map((r) => [r.asset_id, formatAmount(parseReconcileAmount(r.total, 'accounts.balance'))]));
}

export interface ReconciliationReport {
  readonly ok: boolean;
  readonly ranAt: Date;
  readonly balances: ReconcileResult;
  readonly chain: ChainResult;
  readonly totals: Record<string, string>;
  /** Assets that do not net to zero — the most serious failure possible. */
  readonly unbalancedAssets: string[];
  /** Unavailable checks in a mismatch report; false/empty fields do not claim those checks finished. */
  readonly incompleteChecks?: readonly { check: 'balances' | 'chain' | 'totals'; errorCode: string }[];
  /** Definitively invalid numeric values read from the book, without inventing a numeric drift. */
  readonly corruptAmountFields?: readonly string[];
}

/**
 * The full run. Scheduled hourly; also runnable on demand from apps/admin when
 * an operator wants to prove the book is intact before, say, a treasury move.
 */
export async function runReconciliation(sql: ReconciliationDb): Promise<ReconciliationReport> {
  const checks = await Promise.allSettled([reconcileBalances(sql), verifyChain(sql), totalsByAsset(sql)]);
  const [balanceCheck, chainCheck, totalCheck] = checks;
  const balances: ReconcileResult = balanceCheck.status === 'fulfilled' ? balanceCheck.value : { ok: false, drift: [], accountsChecked: 0 };
  const chain: ChainResult = chainCheck.status === 'fulfilled' ? chainCheck.value : { ok: false, brokenAt: 'incomplete', length: 0 };
  const totals = totalCheck.status === 'fulfilled' ? totalCheck.value : {};
  const unbalancedAssets = Object.entries(totals)
    .filter(([, total]) => total !== '0')
    .map(([asset]) => asset);
  const names = ['balances', 'chain', 'totals'] as const;
  const incompleteChecks: Array<{ check: (typeof names)[number]; errorCode: string }> = [];
  const corruptAmountFields: string[] = [];
  for (const [index, check] of checks.entries()) {
    if (check.status !== 'rejected') continue;
    if (check.reason instanceof CorruptReconcileAmountError) corruptAmountFields.push(check.reason.field);
    else incompleteChecks.push({ check: names[index]!, errorCode: reconcileErrorCode(check.reason) });
  }
  const mismatch =
    (balanceCheck.status === 'fulfilled' && !balanceCheck.value.ok) ||
    (chainCheck.status === 'fulfilled' && !chainCheck.value.ok) ||
    unbalancedAssets.length > 0 ||
    corruptAmountFields.length > 0;
  // A failed sibling cannot erase an established mismatch. Conversely, clean
  // partial checks never turn a timeout into a mismatch.
  if (!mismatch) {
    const failed = checks.find((check) => check.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  }
  return {
    ok: !mismatch,
    ranAt: new Date(),
    balances,
    chain,
    totals,
    unbalancedAssets,
    ...(incompleteChecks.length ? { incompleteChecks } : {}),
    ...(corruptAmountFields.length ? { corruptAmountFields } : {}),
  };
}

// ── The snapshot runner ──────────────────────────────────────────────────────
//
// The proof reads ONE consistent snapshot of the book and holds NO lock on
// `chain_tip`. Every post commits its entries, the `accounts.balance` update and
// the `chain_tip` advance in a single transaction under the tip lock, so a
// REPEATABLE READ snapshot always sees a whole prefix of the chain, never half
// a post. The ledger is append-only at runtime, so a proof of the snapshot at
// seq S is a proof of "everything through S"; posts that commit while it runs
// are simply not part of this verdict.
//
// What this costs, stated plainly: posts continue on a book that may already be
// broken for as long as the proof runs. A mismatch is frozen when the proof
// finishes, not while it reads. See ADR 2026-10-14-ledger-reconcile-snapshot-no-freeze-on-incomplete.

export type ReconcileOutcome = 'ok' | 'mismatch' | 'incomplete';

/** What the snapshot covered. All text: a seq or entry id is never a JS number. */
export interface ReconciledTip {
  readonly seq: string;
  readonly hash: string | null;
  /** Highest `ledger_entries.id` visible in the snapshot. Null when the book has no entries. */
  readonly throughEntryId: string | null;
  /** When the snapshot was taken (database clock). */
  readonly snapshotAt: Date;
}

export type SnapshotRun =
  /** Another run holds the single-flight lock. Nothing was read or written. */
  | { readonly outcome: 'skipped' }
  | {
      readonly outcome: 'ok';
      readonly report: ReconciliationReport;
      readonly tip: ReconciledTip;
      readonly runId: string;
      readonly snapshotted: true;
    }
  | {
      readonly outcome: 'mismatch';
      readonly report: ReconciliationReport;
      readonly tip: ReconciledTip | null;
      /** Null when the run row itself could not be written; the verdict still stands. */
      readonly runId: string | null;
      readonly snapshotted: false;
      readonly recordError?: unknown;
    }
  | {
      readonly outcome: 'incomplete';
      readonly phase: 'start' | 'tip' | 'proof' | 'snapshot';
      readonly error: unknown;
      readonly errorCode: string;
      /** Null when even the incomplete row could not be written. */
      readonly runId: string | null;
      readonly recordError?: unknown;
    };

export interface SnapshotRunOptions {
  /** Per-run `statement_timeout`. Defaults to 10 minutes. Validated before it reaches SQL. */
  readonly statementTimeoutMs?: number;
  /** The proof itself. A seam for tests; production always runs `runReconciliation`. */
  readonly prove?: (tx: ReconciliationDb) => Promise<ReconciliationReport>;
  /**
   * Test seam. Thrown from the `reserve()` try, before the proof connection is
   * reserved, so the failure is phase `start`. Production omits this.
   */
  readonly reserveFailure?: unknown;
}

/**
 * Same key in every replica and in the operator path: `pg_try_advisory_lock` on it is the
 * single-flight gate. Advisory locks are per DATABASE, so the key carries the schema: one book,
 * one lock. (Production schema is `ledger`; every test database gets its own schema, so test
 * files running in parallel cannot make each other skip.) A reserved connection holds the session lock across the proof and snapshot-write
 * transactions; cleanup explicitly unlocks it before returning that connection.
 */
export const RECONCILE_LOCK_SQL = "hashtext('ledger.reconcile:' || current_schema())::bigint";

/** Session-local staging copy of the proof's balances (see `runSnapshotReconciliation`). */
const STAGING_TABLE = 'reconcile_snapshot_balances';

/** The error code worth keeping on a run row: whatever `code` the error carries, or `unknown`. */
export function reconcileErrorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.length > 0 ? code.slice(0, 64) : 'unknown';
}

/**
 * Proven corruption, the only thrown errors that freeze immediately (D-128 / PLT-0001).
 * A completed report with `ok: false` is the other immediate freeze, and it does not
 * come through here. Every other throw, including no code, TLS, and unlisted network
 * codes, is incomplete and counts toward N.
 */
export function isProvenReconcileCorruption(error: unknown): boolean {
  return error instanceof CorruptReconcileAmountError || error instanceof CorruptChainTipError;
}

/** A proof that threw before it could say the book was consistent. Not a numeric drift. */
function failedProofReport(): ReconciliationReport {
  return {
    ok: false,
    ranAt: new Date(),
    balances: { ok: false, drift: [], accountsChecked: 0 },
    chain: { ok: false, brokenAt: 'proof', length: 0 },
    totals: {},
    unbalancedAssets: [],
  };
}

function boundedMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 500 ? `${message.slice(0, 500)}…` : message;
}

/** Counts and the first break only. The full report goes to the operator, not into a status table. */
function reportDetail(report: ReconciliationReport): Record<string, unknown> {
  return {
    accountsChecked: report.balances.accountsChecked,
    driftCount: report.balances.ok ? 0 : report.balances.drift.length,
    firstDriftAccountId: report.balances.ok ? null : (report.balances.drift[0]?.accountId ?? null),
    chainOk: report.chain.ok,
    chainLength: report.chain.length,
    chainBrokenAt: report.chain.ok ? null : report.chain.brokenAt,
    unbalancedAssets: report.unbalancedAssets,
    incompleteChecks: report.incompleteChecks ?? [],
    corruptAmountFields: report.corruptAmountFields ?? [],
  };
}

async function insertRunRow(
  db: ReconciliationDb,
  row: {
    startedAt: Date;
    outcome: ReconcileOutcome;
    tip: ReconciledTip | null;
    errorCode: string | null;
    detail: Record<string, unknown>;
  },
): Promise<string> {
  const rows = await db<Array<{ id: string }>>`
    INSERT INTO reconcile_runs (started_at, outcome, kind, through_seq, through_entry_id, tip_hash, error_code, detail)
    VALUES (${row.startedAt}, ${row.outcome}, 'full', ${row.tip?.seq ?? null}::bigint, ${row.tip?.throughEntryId ?? null}::text,
            ${row.tip?.hash ?? null}::text, ${row.errorCode}::text, ${db.json(row.detail as never)})
    RETURNING id::text AS id
  `;
  return rows[0]!.id;
}

/** A completed mismatch and its durable halt share one short commit. */
async function freezeMismatch(tx: TransactionSql): Promise<void> {
  try {
    await writeFreezeInTransaction(tx, { frozen: true, reason: RECONCILE_MISMATCH_REASON, actor: RECONCILE_ACTOR });
  } catch (error) {
    if (!(error instanceof LedgerError && error.code === 'ledger.freeze_attributed')) throw error;
  }
}

/** Best effort, on a fresh short transaction of its own: the snapshot one is gone or poisoned. */
async function recordAfterRollback(
  sql: ReconciliationDb,
  row: Parameters<typeof insertRunRow>[1],
): Promise<{ runId: string | null; recordError?: unknown }> {
  try {
    if (row.outcome === 'mismatch' && 'begin' in sql) {
      return {
        runId: await sql.begin(async (tx) => {
          await freezeMismatch(tx);
          return insertRunRow(tx, row);
        }),
      };
    }
    return { runId: await insertRunRow(sql, row) };
  } catch (recordError) {
    return { runId: null, recordError };
  }
}

/** An unfinished run. One of these does not freeze; N of them in a row do, in the tick. */
async function recordIncomplete(
  sql: ReconciliationDb,
  startedAt: Date,
  error: unknown,
  phase: 'start' | 'tip' | 'proof' | 'snapshot',
  tip: ReconciledTip | null,
): Promise<Extract<SnapshotRun, { outcome: 'incomplete' }>> {
  const errorCode = reconcileErrorCode(error);
  const recorded = await recordAfterRollback(sql, {
    startedAt,
    outcome: 'incomplete',
    tip,
    errorCode,
    detail: { phase, message: boundedMessage(error) },
  });
  return {
    outcome: 'incomplete',
    phase,
    error,
    errorCode,
    runId: recorded.runId,
    ...(recorded.recordError !== undefined ? { recordError: recorded.recordError } : {}),
  };
}

/**
 * A thrown `CorruptReconcileAmountError` or `CorruptChainTipError`, and the proof
 * has not already returned ok. Record it on the mismatch path so the halt commits
 * with the row when that insert works, and so the caller still freezes when the
 * insert rolls back. A green proof whose snapshot write then fails must not come here.
 */
async function recordFailedProof(
  sql: ReconciliationDb,
  startedAt: Date,
  error: unknown,
  phase: 'start' | 'tip' | 'proof' | 'snapshot',
  tip: ReconciledTip | null,
): Promise<Extract<SnapshotRun, { outcome: 'mismatch' }>> {
  const report = failedProofReport();
  const recorded = await recordAfterRollback(sql, {
    startedAt,
    outcome: 'mismatch',
    tip,
    errorCode: reconcileErrorCode(error),
    detail: { phase, message: boundedMessage(error), failedProof: true },
  });
  return {
    outcome: 'mismatch',
    report,
    tip,
    runId: recorded.runId,
    snapshotted: false,
    recordError: recorded.recordError ?? error,
  };
}

/**
 * Prove the book from one REPEATABLE READ snapshot and write the verdict.
 *
 * Owned dedicated connection for the whole run, READ WRITE, no
 * `chain_tip` lock, no retry loop: a retry would be a second ten-minute
 * snapshot inside one tick.
 *
 * Why the snapshot rows are staged, not inserted inside the snapshot. The
 * `balance_snapshots` rows must carry the balances the proof checked (the
 * gap-commit bug migration 0015 fixed), so they are READ from the proof's
 * snapshot. But `balance_snapshots.account_id` is a foreign key to `accounts`,
 * and an FK check locks the referenced row; in REPEATABLE READ that lock raises
 * 40001 ("could not serialize access due to concurrent update") as soon as a
 * post has updated ANY account since the snapshot began, which on a live book
 * is every run. So inside the snapshot the balances are copied to a
 * session-local temp table (no FK, never visible to anyone else), and after the
 * snapshot commits a short READ COMMITTED transaction on the same connection
 * writes the staged rows together with the `ok` run row: atomic, and still
 * pinned to the proof's tip because the values never left the snapshot.
 *
 * Outcomes:
 *   ok         proof green. Snapshot rows and an `ok` run row are committed.
 *   mismatch   a completed report with ok:false, or a thrown CorruptReconcileAmountError
 *              or CorruptChainTipError before that proof returned ok. The `mismatch`
 *              run row and durable halt commit together in a short READ COMMITTED
 *              transaction (the caller freezes again if that commit rolls back).
 *   incomplete every other error: no code, TLS (CERT_HAS_EXPIRED), an unlisted
 *              network code, a Postgres error, or a snapshot write after a green
 *              proof. errorCode is reconcileErrorCode ('unknown' when it has no
 *              code). Rolled back, a best-effort `incomplete` row is written on a
 *              fresh transaction. One incomplete run does not freeze.
 *   skipped    another run holds the advisory lock.
 */
export async function runSnapshotReconciliation(sql: Sql, options: SnapshotRunOptions = {}): Promise<SnapshotRun> {
  const timeoutMs = validReconcileStatementTimeoutMs(options.statementTimeoutMs ?? DEFAULT_RECONCILE_STATEMENT_TIMEOUT_MS);
  const prove = options.prove ?? runReconciliation;
  const startedAt = new Date();

  // One holder so the catch below sees what the run learned before it failed.
  const state: { phase: 'start' | 'tip' | 'proof' | 'snapshot'; tip: ReconciledTip | null; verdict: ReconciliationReport | null } = {
    phase: 'start',
    tip: null,
    // Set the instant the proof returns. A verdict must survive a failed insert after it.
    verdict: null,
  };

  // Own this connection's lifecycle. A dropped proof connection must never end
  // or retain a session lock in the posting pool. Preserve its configured SQL
  // types, transforms, credentials and search_path without logging any options.
  const source = sql.options;
  const proofSql = postgres({
    host: source.host.map((host, index) => `${host}:${source.port[index] ?? source.port[0]}`).join(','),
    database: source.database,
    user: source.user,
    // postgres.js exposes the parsed credential as `pass`; its declarations
    // incorrectly narrow that runtime string/function to null.
    password: (source as unknown as { pass: postgres.Options<{}>['password'] }).pass,
    ssl: source.ssl,
    target_session_attrs: source.target_session_attrs,
    // Supported by postgres.js at runtime, absent from its current declarations.
    ...('sslnegotiation' in source ? { sslnegotiation: source.sslnegotiation } : {}),
    path: source.path,
    connection: source.connection,
    types: source.types,
    transform: source.transform,
    prepare: source.prepare,
    fetch_types: source.fetch_types,
    connect_timeout: source.connect_timeout,
    idle_timeout: source.idle_timeout,
    max_lifetime: source.max_lifetime,
    onnotice: source.onnotice,
    max: 1,
  });
  let conn: postgres.ReservedSql;
  try {
    if (options.reserveFailure !== undefined) throw options.reserveFailure;
    conn = await proofSql.reserve();
  } catch (error) {
    await proofSql.end({ timeout: 0 });
    if (isProvenReconcileCorruption(error)) {
      return recordFailedProof(sql, startedAt, error, 'start', null);
    }
    return recordIncomplete(sql, startedAt, error, 'start', null);
  }
  let open = false;
  let staged = false;
  let released = false;
  let locked = false;
  // Hand the connection back BEFORE anything else needs the pool (a max:1 pool would deadlock on it).
  const cleanup = async () => {
    if (open) await conn.unsafe('ROLLBACK').catch(() => undefined);
    open = false;
    // The temp table lives as long as the session, and the session goes back to the pool.
    if (staged) await conn.unsafe(`DROP TABLE IF EXISTS pg_temp.${STAGING_TABLE}`).catch(() => undefined);
    staged = false;
    if (locked) {
      try {
        await conn.unsafe(`SELECT pg_advisory_unlock(${RECONCILE_LOCK_SQL})`);
      } catch {
        // Never return a session with an unknown advisory-lock state to the pool.
        // Closing this proof-only client releases any remaining lock.
        await proofSql.end({ timeout: 0 });
      }
      locked = false;
    }
    if (!released) conn.release();
    released = true;
    await proofSql.end({ timeout: 0 });
  };
  const begin = async (isolation: string) => {
    await conn.unsafe(`BEGIN ISOLATION LEVEL ${isolation} READ WRITE`);
    open = true;
    // SET takes no bind parameters; the value is a validated integer. Same bound for both transactions.
    await conn.unsafe(`SET LOCAL statement_timeout = ${timeoutMs}`);
  };
  const commit = async () => {
    await conn.unsafe('COMMIT');
    open = false;
  };

  try {
    await begin('REPEATABLE READ');

    // First snapshot-taking statement: from here every read sees one commit prefix.
    locked = true; // unlock is harmless even if acquisition is canceled before its reply
    const [gate] = await conn.unsafe<Array<{ got: boolean; at: Date }>>(
      `SELECT pg_try_advisory_lock(${RECONCILE_LOCK_SQL}) AS got, clock_timestamp() AS at`,
    );
    if (!gate?.got) {
      await conn.unsafe('ROLLBACK');
      open = false;
      return { outcome: 'skipped' };
    }

    locked = true;
    state.phase = 'tip';
    const tipRows = await conn<Array<{ hash: string | null; seq: string; through_entry_id: string | null }>>`
      SELECT t.hash, t.seq::text AS seq, (SELECT max(id)::text FROM ledger_entries) AS through_entry_id
        FROM chain_tip t
       WHERE t.id = true
    `;
    const row = tipRows[0];
    if (row && (typeof row.seq !== 'string' || (row.hash !== null && typeof row.hash !== 'string'))) {
      throw new CorruptChainTipError();
    }
    const tip: ReconciledTip | null = row
      ? { seq: row.seq, hash: row.hash, throughEntryId: row.through_entry_id, snapshotAt: gate.at }
      : null;
    state.tip = tip;

    state.phase = 'proof';
    const proved = await prove(conn);
    // A successful read showing a missing singleton is structural corruption,
    // not an interrupted proof. Preserve the completed mismatch verdict.
    const report: ReconciliationReport = tip
      ? proved
      : {
          ...proved,
          ok: false,
          chain: { ok: false, brokenAt: 'chain_tip', length: proved.chain.length },
        };
    state.verdict = report;

    if (!report.ok) {
      // A completed not-ok report: record it and let the caller freeze. No snapshot rows:
      // writing the drifted cache as an anchor would heal the break as success.
      await commit();
      await begin('READ COMMITTED');
      await freezeMismatch(conn as unknown as TransactionSql);
      const runId = await insertRunRow(conn, { startedAt, outcome: 'mismatch', tip, errorCode: null, detail: reportDetail(report) });
      await commit();
      return { outcome: 'mismatch', report, tip, runId, snapshotted: false };
    }

    if (!tip) throw new Error('verified reconciliation has no tip');
    state.phase = 'snapshot';
    // Still inside the proof's snapshot: these are the balances the proof just checked.
    await conn.unsafe(`DROP TABLE IF EXISTS pg_temp.${STAGING_TABLE}`);
    staged = true;
    await conn.unsafe(`CREATE TEMP TABLE ${STAGING_TABLE} ON COMMIT PRESERVE ROWS AS SELECT id AS account_id, balance FROM accounts`);
    await commit();

    // Short READ COMMITTED transaction: the FK check sees live rows, nothing to serialize against.
    await begin('READ COMMITTED');
    await conn.unsafe(
      `INSERT INTO balance_snapshots (account_id, as_of, balance, through_entry_id, chain_tip_seq, chain_tip_hash)
       SELECT account_id, $1::timestamptz, balance, $2::text, $3::bigint, $4::text
         FROM pg_temp.${STAGING_TABLE}`,
      [tip.snapshotAt, tip.throughEntryId, tip.seq, tip.hash],
    );
    const runId = await insertRunRow(conn, { startedAt, outcome: 'ok', tip, errorCode: null, detail: reportDetail(report) });
    await commit();
    return { outcome: 'ok', report, tip, runId, snapshotted: true };
  } catch (error) {
    await cleanup();

    const settled = state.verdict;
    if (settled !== null && !settled.ok) {
      // The proof FINISHED and found a break; only recording it failed. The verdict is
      // not lost: report mismatch so the caller still freezes.
      const recorded = await recordAfterRollback(sql, {
        startedAt,
        outcome: 'mismatch',
        tip: state.tip,
        errorCode: null,
        detail: { ...reportDetail(settled), recordedAfterRollback: true },
      });
      return { outcome: 'mismatch', report: settled, tip: state.tip, runId: recorded.runId, snapshotted: false, recordError: error };
    }

    if (settled?.ok === true) {
      // The proof already returned ok. A later failure, including the snapshot
      // insert, is unfinished work. It must never be recorded as a mismatch.
      return recordIncomplete(sql, startedAt, error, state.phase, state.tip);
    }

    if (isProvenReconcileCorruption(error)) {
      return recordFailedProof(sql, startedAt, error, state.phase, state.tip);
    }

    return recordIncomplete(sql, startedAt, error, state.phase, state.tip);
  } finally {
    await cleanup();
  }
}

/**
 * When the book was last proved consistent, from the latest `ok` run. `at` and
 * `seq` are null before the first one. `firstAttemptAt` is only read in that
 * case: it gives the staleness reporting a durable "not verified since" origin
 * that survives restarts.
 */
export interface LastVerified {
  readonly at: Date | null;
  readonly seq: string | null;
  readonly firstAttemptAt: Date | null;
}

export async function readLastVerified(sql: ReconciliationDb): Promise<LastVerified> {
  const rows = await sql<Array<{ finished_at: Date; through_seq: string }>>`
    SELECT finished_at, through_seq::text AS through_seq
      FROM reconcile_runs
     WHERE outcome = 'ok'
     ORDER BY through_seq DESC, id DESC
     LIMIT 1
  `;
  const row = rows[0];
  if (row) return { at: row.finished_at, seq: row.through_seq, firstAttemptAt: null };
  const first = await sql<Array<{ first: Date | null }>>`SELECT min(started_at) AS first FROM reconcile_runs`;
  return { at: null, seq: null, firstAttemptAt: first[0]?.first ?? null };
}

/**
 * Incomplete runs after the latest ok or mismatch. A restart reads this instead
 * of starting the streak at zero. An operator thaw writes neither outcome, so
 * it does not clear the count. A non-integer result throws; the tick then uses
 * its in-memory count.
 */
export async function countConsecutiveIncompleteRuns(sql: ReconciliationDb): Promise<number> {
  const rows = await sql<Array<{ n: number | string }>>`
    SELECT count(*)::int AS n
      FROM reconcile_runs
     WHERE outcome = 'incomplete'
       AND id > COALESCE((SELECT max(id) FROM reconcile_runs WHERE outcome IN ('ok', 'mismatch')), 0)
  `;
  const n = rows[0]?.n;
  if (typeof n === 'number' && Number.isInteger(n) && n >= 0) return n;
  throw new Error('consecutive incomplete run count was not a non-negative integer');
}

/** Thrown when a mismatch was found and the freeze that must follow it did not land. */
export class ReconcileFreezeFailedError extends LedgerError {
  constructor(
    readonly report: ReconciliationReport,
    override readonly cause: unknown,
  ) {
    super('reconciliation found a mismatch but the freeze did not land', 'ledger.reconcile_freeze_failed');
  }
}

/** What the scheduled job needs from the service: the mismatch handler, nothing else. */
export interface ScheduledReconcileLedger {
  /**
   * Freeze posting for a completed not-ok report, in its own READ COMMITTED
   * transaction, then publish. An operator freeze already standing is left standing.
   */
  handleReconciliationMismatch(report: ReconciliationReport): Promise<void>;
}

export type ScheduledReconcileResult =
  | { readonly outcome: 'skipped' }
  | {
      readonly outcome: 'ok';
      readonly report: ReconciliationReport;
      readonly snapshotted: true;
      readonly run: SnapshotRun & { outcome: 'ok' };
    }
  | {
      readonly outcome: 'mismatch';
      readonly report: ReconciliationReport;
      readonly snapshotted: false;
      readonly run: SnapshotRun & { outcome: 'mismatch' };
    }
  | {
      readonly outcome: 'incomplete';
      readonly report: null;
      readonly snapshotted: false;
      readonly run: SnapshotRun & { outcome: 'incomplete' };
    };

/**
 * The scheduled job (and the body the operator door shares): run the snapshot
 * proof, then act on the outcome. Only a COMPLETED not-ok proof freezes.
 * `incomplete` returns, it does not throw, and never touches `posting_freeze`.
 */
export async function runScheduledReconciliation(
  sql: Sql,
  ledger: ScheduledReconcileLedger,
  options: SnapshotRunOptions = {},
): Promise<ScheduledReconcileResult> {
  const run = await runSnapshotReconciliation(sql, options);
  switch (run.outcome) {
    case 'skipped':
      return { outcome: 'skipped' };
    case 'ok':
      return { outcome: 'ok', report: run.report, snapshotted: true, run };
    case 'incomplete':
      return { outcome: 'incomplete', report: null, snapshotted: false, run };
    case 'mismatch':
      try {
        await ledger.handleReconciliationMismatch(run.report);
      } catch (cause) {
        throw new ReconcileFreezeFailedError(run.report, cause);
      }
      return { outcome: 'mismatch', report: run.report, snapshotted: false, run };
  }
}
