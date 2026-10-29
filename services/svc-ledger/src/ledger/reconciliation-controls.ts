/**
 * Operator reconciliation controls (OPS-reconciliation-01).
 *
 * Beside the three built-in proofs. Nothing here posts or freezes. A result
 * row is committed before any balance read. An outside snapshot comes through
 * the contract shape; no snapshot is the word `unset`, not null and not zero.
 */

import { createHash } from 'node:crypto';
import type { JSONValue, Sql, TransactionSql } from 'postgres';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import {
  LEDGER_RECONCILE_ASOF_INVALID,
  LEDGER_RECONCILE_BUILTIN_IMMUTABLE,
  LEDGER_RECONCILE_CONTROL_NOT_FOUND,
  LEDGER_RECONCILE_RAIL_SOURCE_UNSET,
  LEDGER_RECONCILE_SOURCE_UNAVAILABLE,
  OPS_CONTROL_MARGIN_UNSET,
  OPS_CONTROL_POLICY_UNSET,
  OPS_CONTROL_ACTOR_UNSET,
  OPS_CONTROL_REASON_REQUIRED,
  OPS_CONTROL_STATE_ILLEGAL,
  defineReconciliationControlInputSchema,
  listReconciliationControlRunsInputSchema,
  RECONCILIATION_RUN_LIST_DEFAULT,
  reconciliationAccountSetSchema,
  reconciliationControlRunListSchema,
  reconciliationEvaluationFeedInputSchema,
  reconciliationEvaluationFeedSchema,
  type ReconciliationEvaluationFeed,
  reconciliationControlRunSchema,
  reconciliationControlViewSchema,
  reconciliationScheduleSchema,
  reconciliationThresholdSchema,
  reconciliationToleranceSchema,
  runReconciliationControlInputSchema,
  updateReconciliationControlInputSchema,
  RECONCILIATION_LIFECYCLE_MOVES,
  type DefineReconciliationControlInput,
  type ReconciliationAccountSet,
  type ReconciliationControlRunList,
  type ReconciliationControlRunView,
  type ReconciliationControlView,
  type ReconciliationLifecycle,
  type ReconciliationSchedule,
  type ReconciliationThreshold,
  type UpdateReconciliationControlInput,
} from '@intafaced/contracts/ledger-reconciliation';
import type { ActionApprovalConsumer as LedgerApprovalConsumer } from './action-approval-consume.js';
import { consumeLedgerApproval } from './action-approval-consume.js';
import { verifyChain } from './reconcile.js';
import { ReconciliationControlError } from './reconciliation-control-error.js';
import {
  assertNotFuture,
  dueInstant,
  periodBounds,
  periodForSchedule,
  readInstant,
  type ReconciliationPeriod,
} from './reconciliation-schedule.js';

type Db = Sql | TransactionSql;

export interface SnapshotRead {
  readonly kind: 'unset' | 'unavailable' | 'snapshot';
  readonly asOf?: string;
  readonly balances?: readonly { readonly assetId: string; readonly amount: string }[];
}

export interface ReconciliationSources {
  /** With `rail`, that rail's own outside statement; without, the whole outside book. */
  outsideBalance(readAt: Date, rail?: string): Promise<SnapshotRead>;
  parity(readAt: Date): Promise<SnapshotRead>;
}

export function unsetReconciliationSources(): ReconciliationSources {
  return {
    outsideBalance: async () => ({ kind: 'unset' }),
    parity: async () => ({ kind: 'unset' }),
  };
}

export interface ControlActor {
  readonly actorId: string;
  readonly requestId: string | null;
}

interface ToleranceStored {
  default?: string;
  byAsset?: Record<string, string>;
}

interface ControlRow {
  id: string;
  builtin: boolean;
  builtin_key: string | null;
  template: ReconciliationControlView['template'];
  check_kind: 'replay' | 'chain' | 'netting' | 'replay_and_netting' | null;
  state: ReconciliationControlView['state'];
  explanation: string;
  labels: string[];
  schedule: ReconciliationSchedule | null;
  severity: 'info' | 'warning' | 'critical' | null;
  period: ReconciliationPeriod | null;
  tolerance: ToleranceStored | null;
  margin: string | null;
  account_set: ReconciliationAccountSet;
  threshold: ReconciliationThreshold | null;
  version: number;
  /** The last resume. A period that fell due before it was paused time and is not caught up. */
  resumed_at: Date | null;
}

interface AssetEvidence {
  assetId: string;
  observed: string;
  expected: string | 'unset';
  difference: string | 'unset';
  tolerance: string | 'unset';
}

interface Verdict {
  status: 'PASS' | 'FAIL' | 'ERROR' | 'UNSET';
  phase: string;
  errorCode: string;
  assets: AssetEvidence[];
  outsideSide: 'unset' | 'snapshot' | 'unavailable' | 'not_applicable';
  sources: ReconciliationControlRunView['sources'];
}

function actorOf(actorId: string): string {
  const actor = actorId.trim();
  if (!actor) throw new ReconciliationControlError(OPS_CONTROL_ACTOR_UNSET);
  return actor;
}

function reasonOf(reason: string): string {
  const trimmed = reason.trim();
  if (trimmed.length < 12 || trimmed.length > 500) throw new ReconciliationControlError(OPS_CONTROL_REASON_REQUIRED);
  return trimmed;
}

function likePrefix(prefix: string): string {
  return `${prefix.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

function asJson(value: unknown): JSONValue {
  return JSON.parse(JSON.stringify(value)) as JSONValue;
}

function fingerprint(parts: Record<string, string>): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

function present<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

function toleranceReady(tolerance: ToleranceStored | null): boolean {
  return typeof tolerance?.default === 'string' && tolerance.default.trim() !== '';
}

function policyReady(row: Pick<ControlRow, 'template' | 'schedule' | 'severity' | 'tolerance' | 'threshold'>): boolean {
  if (!toleranceReady(row.tolerance) || !row.schedule || !row.severity) return false;
  if (row.template === 'threshold') {
    return !!row.threshold && Object.keys(row.threshold.byAsset).length > 0;
  }
  return true;
}

function setOrUnset<T extends string>(value: T | null): { status: 'unset' } | { status: 'set'; value: T } {
  return value === null ? { status: 'unset' } : { status: 'set', value };
}

function toView(row: ControlRow): ReconciliationControlView {
  const schedule = row.schedule ? reconciliationScheduleSchema.parse(row.schedule) : null;
  const period = row.period ?? (schedule ? periodForSchedule(schedule) : null);
  const tolerance = row.tolerance;
  const threshold = row.threshold ? reconciliationThresholdSchema.parse(row.threshold) : null;
  return reconciliationControlViewSchema.parse({
    id: row.id,
    builtin: row.builtin,
    template: row.template,
    checkKind: row.check_kind ? { status: 'set', value: row.check_kind } : { status: 'unset' },
    state: row.state,
    explanation: row.explanation,
    labels: Array.isArray(row.labels) ? row.labels : [],
    schedule: schedule && period ? { status: 'set', value: schedule, period } : { status: 'unset' },
    severity: setOrUnset(row.severity),
    tolerance:
      tolerance && typeof tolerance.default === 'string'
        ? { status: 'set', default: tolerance.default, byAsset: tolerance.byAsset ?? {} }
        : { status: 'unset' },
    margin: setOrUnset(row.margin),
    accountSet: reconciliationAccountSetSchema.parse(row.account_set),
    threshold: threshold ? { status: 'set', bound: threshold.bound, byAsset: threshold.byAsset } : { status: 'unset' },
    version: Number(row.version),
  });
}

async function audit(
  tx: Db,
  controlId: string,
  actor: string,
  reason: string,
  action: 'define' | 'update' | 'run',
  requestId: string | null,
  detail: object,
): Promise<void> {
  await tx`
    INSERT INTO reconciliation_control_audit (control_id, actor_id, reason, action, request_id, detail)
    VALUES (${controlId}, ${actor}, ${reason}, ${action}, ${requestId}, ${tx.json(asJson(detail))})
  `;
}

const CONTROL_COLUMNS = `
  id, builtin, builtin_key, template, check_kind, state, explanation, labels, schedule, severity, period,
  tolerance, margin, account_set, threshold, version, resumed_at
`;

async function loadControl(sql: Db, id: string, lock: boolean): Promise<ControlRow> {
  const rows = await sql<ControlRow[]>`
    SELECT ${sql.unsafe(CONTROL_COLUMNS)}
      FROM reconciliation_controls
     WHERE id = ${id}
     ${lock ? sql.unsafe('FOR UPDATE') : sql.unsafe('')}
  `;
  const row = rows[0];
  if (!row) throw new ReconciliationControlError(LEDGER_RECONCILE_CONTROL_NOT_FOUND);
  return row;
}

/**
 * An operator account set is never the whole book, and netting to zero only holds over the whole book, so an
 * operator ledger invariant is a replay check. The built-in netting control nets the whole book.
 */
function checkKindFor(template: ControlRow['template']): ControlRow['check_kind'] {
  return template === 'ledger_invariant' ? 'replay' : null;
}

/** Scheduled runs own this operation-id prefix; an operator run may not use it. */
const SCHEDULE_OPERATION_PREFIX = 'schedule:';

export async function defineReconciliationControl(
  sql: Sql,
  actor: ControlActor,
  input: DefineReconciliationControlInput,
): Promise<ReconciliationControlView> {
  const parsed = defineReconciliationControlInputSchema.parse(input);
  const who = actorOf(actor.actorId);
  const reason = reasonOf(parsed.reason);
  const schedule = parsed.schedule ?? null;
  const period = schedule ? periodForSchedule(schedule) : null;
  const tolerance = parsed.tolerance ?? null;
  const activate = parsed.activate === true;
  const ready = policyReady({
    template: parsed.template,
    schedule,
    severity: parsed.severity ?? null,
    tolerance,
    threshold: parsed.threshold ?? null,
  });
  // Refused before anything is stored: define has no idempotency key, so a refused activate must not leave a draft.
  if (activate && !ready) throw new ReconciliationControlError(OPS_CONTROL_POLICY_UNSET);
  const view = await sql.begin(async (tx) => {
    const inserted = await tx<ControlRow[]>`
      INSERT INTO reconciliation_controls (
        builtin, template, check_kind, state, explanation, labels, schedule, severity, period, tolerance, margin,
        account_set, threshold, defined_by, defined_reason
      ) VALUES (
        false,
        ${parsed.template},
        ${checkKindFor(parsed.template)},
        'draft',
        ${parsed.explanation ?? ''},
        ${tx.json(parsed.labels ?? [])},
        ${schedule ? tx.json(schedule) : null},
        ${parsed.severity ?? null},
        ${period},
        ${tolerance ? tx.json(tolerance) : null},
        ${parsed.margin ?? null},
        ${tx.json(parsed.accountSet)},
        ${parsed.threshold ? tx.json(parsed.threshold) : null},
        ${who},
        ${reason}
      )
      RETURNING ${tx.unsafe(CONTROL_COLUMNS)}
    `;
    const row = inserted[0];
    if (!row) throw new ReconciliationControlError(LEDGER_RECONCILE_SOURCE_UNAVAILABLE);
    await audit(tx, row.id, who, reason, 'define', actor.requestId, { template: parsed.template, activate });
    if (!activate) return toView(row);
    const activated = await tx<ControlRow[]>`
      UPDATE reconciliation_controls
         SET state = 'active', version = version + 1, updated_at = clock_timestamp()
       WHERE id = ${row.id}
       RETURNING ${tx.unsafe(CONTROL_COLUMNS)}
    `;
    const next = activated[0];
    if (!next) throw new ReconciliationControlError(LEDGER_RECONCILE_SOURCE_UNAVAILABLE);
    await audit(tx, row.id, who, reason, 'update', actor.requestId, { state: 'active' });
    return toView(next);
  });
  return view;
}

export async function updateReconciliationControl(
  sql: Sql,
  actor: ControlActor,
  input: UpdateReconciliationControlInput,
  approvals: LedgerApprovalConsumer,
): Promise<ReconciliationControlView> {
  const parsed = updateReconciliationControlInputSchema.parse(input);
  const who = actorOf(actor.actorId);
  const reason = reasonOf(parsed.reason);
  return sql.begin(async (tx) => {
    const current = await loadControl(tx, parsed.controlId, true);
    if (current.builtin) throw new ReconciliationControlError(LEDGER_RECONCILE_BUILTIN_IMMUTABLE);
    if (parsed.lifecycle) return moveLifecycle(tx, approvals, parsed, current, parsed.lifecycle, who, reason, actor.requestId);
    // Retired is final. A paused control keeps its edits and is checked again when it resumes; it is not activated here.
    if (current.state === 'retired') throw new ReconciliationControlError(OPS_CONTROL_STATE_ILLEGAL);
    if (current.state === 'paused' && parsed.activate === true) throw new ReconciliationControlError(OPS_CONTROL_STATE_ILLEGAL);
    const schedule = parsed.schedule ?? current.schedule;
    const severity = parsed.severity ?? current.severity;
    const tolerance = parsed.tolerance ?? current.tolerance;
    const threshold = parsed.threshold ?? current.threshold;
    const margin = parsed.margin ?? current.margin;
    const accountSet = parsed.accountSet ?? current.account_set;
    const explanation = parsed.explanation ?? current.explanation;
    const labels = parsed.labels ?? current.labels;
    const period = schedule ? periodForSchedule(reconciliationScheduleSchema.parse(schedule)) : null;
    const activate = parsed.activate === true;
    const nextState = activate ? 'active' : current.state;
    if (activate || current.state === 'active') {
      const ready = policyReady({ template: current.template, schedule, severity, tolerance, threshold });
      if (!ready) throw new ReconciliationControlError(OPS_CONTROL_POLICY_UNSET);
    }
    const updated = await tx<ControlRow[]>`
      UPDATE reconciliation_controls
         SET explanation = ${explanation},
             labels = ${tx.json(labels)},
             schedule = ${schedule ? tx.json(schedule) : null},
             severity = ${severity},
             period = ${period},
             tolerance = ${tolerance ? tx.json(reconciliationToleranceSchema.parse(tolerance)) : null},
             margin = ${margin},
             account_set = ${tx.json(reconciliationAccountSetSchema.parse(accountSet))},
             threshold = ${threshold ? tx.json(reconciliationThresholdSchema.parse(threshold)) : null},
             state = ${nextState},
             version = version + 1,
             updated_at = clock_timestamp()
       WHERE id = ${current.id}
       RETURNING ${tx.unsafe(CONTROL_COLUMNS)}
    `;
    const row = updated[0];
    if (!row) throw new ReconciliationControlError(LEDGER_RECONCILE_SOURCE_UNAVAILABLE);
    await audit(tx, row.id, who, reason, 'update', actor.requestId, { state: row.state, version: row.version });
    return toView(row);
  });
}

/**
 * Pause (active to paused), resume (paused to active, only with a complete policy) and retire (any operator state to
 * retired, final). Each move consumes one two-founder approval bound to the control, the move and the reason at the
 * version read under the row lock, then writes one version and one audit row; anything else is ops.control_state_illegal.
 * The state is checked before the approval is consumed, so an illegal move does not spend it.
 */
async function moveLifecycle(
  tx: Db,
  approvals: LedgerApprovalConsumer,
  ids: { readonly approvalId?: string; readonly operationId?: string },
  current: ControlRow,
  move: ReconciliationLifecycle,
  who: string,
  reason: string,
  requestId: string | null,
): Promise<ReconciliationControlView> {
  const step = RECONCILIATION_LIFECYCLE_MOVES[move];
  if (!step.from.includes(current.state)) throw new ReconciliationControlError(OPS_CONTROL_STATE_ILLEGAL);
  if (move === 'resume') {
    if (!policyReady(current)) throw new ReconciliationControlError(OPS_CONTROL_POLICY_UNSET);
  }
  // One-shot (no replay key): the row lock is held across the consume, and a lost reply needs a fresh approval.
  await consumeLedgerApproval(
    approvals,
    ids,
    'ledger.reconciliation_control.lifecycle',
    'posting_reconciliation_control.lifecycle',
    String(current.version),
    { controlId: current.id, lifecycle: move, reason },
  );
  const updated = await tx<ControlRow[]>`
    UPDATE reconciliation_controls
       SET state = ${step.to},
           version = version + 1,
           updated_at = clock_timestamp(),
           resumed_at = ${move === 'resume' ? tx`clock_timestamp()` : tx`resumed_at`}
     WHERE id = ${current.id}
     RETURNING ${tx.unsafe(CONTROL_COLUMNS)}
  `;
  const row = updated[0];
  if (!row) throw new ReconciliationControlError(LEDGER_RECONCILE_SOURCE_UNAVAILABLE);
  await audit(tx, row.id, who, reason, 'update', requestId, {
    lifecycle: move,
    from: current.state,
    state: row.state,
    version: row.version,
  });
  return toView(row);
}

export async function listReconciliationControls(sql: Sql): Promise<ReconciliationControlView[]> {
  const rows = await sql<ControlRow[]>`
    SELECT ${sql.unsafe(CONTROL_COLUMNS)}
      FROM reconciliation_controls
     ORDER BY builtin DESC, builtin_key ASC NULLS LAST, id ASC
  `;
  return rows.map(toView);
}

/** A control's evaluations, newest first, with the count of all of them. Read-only; any state, retired included. */
export async function listReconciliationControlRuns(sql: Sql, input: unknown): Promise<ReconciliationControlRunList> {
  const parsed = listReconciliationControlRunsInputSchema.parse(input);
  const control = await loadControl(sql, parsed.controlId, false);
  const limit = parsed.limit ?? RECONCILIATION_RUN_LIST_DEFAULT;
  // One snapshot for the count and the page, so a scheduled run landing in between cannot make them disagree. Newest by
  // when the run started: a past-instant run reads an old instant but is still the latest evaluation.
  const { total, rows } = await sql.begin('isolation level repeatable read', async (tx) => {
    const [count] = await tx<Array<{ total: string }>>`
      SELECT count(*)::text AS total FROM reconciliation_control_runs WHERE control_id = ${control.id}
    `;
    const page = await tx<RunRow[]>`
      SELECT ${tx.unsafe(RUN_COLUMNS)}
        FROM reconciliation_control_runs
       WHERE control_id = ${control.id}
       ORDER BY started_at DESC, id DESC
       LIMIT ${limit}
    `;
    return { total: Number(count?.total ?? 0), rows: page };
  });
  return reconciliationControlRunListSchema.parse({ controlId: control.id, total, runs: rows.map(toRun) });
}

/**
 * How long a finished run waits before the evaluation feed shows it. finishRun is one autocommit UPDATE stamped with
 * clock_timestamp(), so its commit lands well inside this; a commit stalled past it could sort behind a reader's cursor,
 * which is why the reader's write is idempotent by run id and it may re-read from an earlier cursor.
 */
export const RECONCILIATION_EVALUATION_SETTLE_SECONDS = 30;

/**
 * Every finished evaluation after the cursor, oldest first by (finished_at, id): the feed svc-ops reads to keep one alert
 * per control, failing asset and period (OPS-reconciliation-03). Read-only, and it reads no table but this service's own.
 */
export async function listReconciliationEvaluations(sql: Sql, input: unknown): Promise<ReconciliationEvaluationFeed> {
  const parsed = reconciliationEvaluationFeedInputSchema.parse(input);
  const after = parsed.after;
  // The cursor carries microseconds, as Postgres stores them: a millisecond cursor would sort before its own row and
  // hand the last evaluation back on every read. It is bound as text, because the driver turns a timestamptz parameter
  // into a JavaScript Date and drops the microseconds.
  const rows = await sql<Array<RunRow & { finished_iso: string; severity: ControlRow['severity'] }>>`
    SELECT ${sql.unsafe(RUN_COLUMNS_AS_R)},
           to_char(r.finished_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS finished_iso,
           c.severity
      FROM reconciliation_control_runs r
      JOIN reconciliation_controls c ON c.id = r.control_id
     WHERE r.status <> 'started'
       AND r.finished_at IS NOT NULL
       AND r.finished_at <= clock_timestamp() - make_interval(secs => ${RECONCILIATION_EVALUATION_SETTLE_SECONDS})
       ${after ? sql`AND (r.finished_at, r.id) > (${after.finishedAt}::text::timestamptz, ${after.id}::uuid)` : sql``}
     ORDER BY r.finished_at ASC, r.id ASC
     LIMIT ${parsed.limit}
  `;
  // A stored run the contract no longer reads is this service's fault, never the caller's: a 500, not a 400.
  try {
    const evaluations = rows.map((row) => {
      const { accounts: _accounts, ...run } = toRun(row);
      return { run, finishedAt: row.finished_iso, severity: setOrUnset(row.severity) };
    });
    const last = rows.at(-1);
    return reconciliationEvaluationFeedSchema.parse({
      evaluations,
      next: last ? { finishedAt: last.finished_iso, id: last.id } : after,
    });
  } catch (err) {
    throw new Error('reconciliation evaluation feed: a stored run does not fit the contract', { cause: err });
  }
}

interface AccountHit {
  id: string;
  asset_id: string;
}

/**
 * In the set at readAt: created by then on the database clock, or holding an entry posted by then on the posting clock.
 * The two clocks can disagree by a millisecond or more (created_at is the post's transaction start in microseconds,
 * posted_at the app's clock in milliseconds), and an account funded at readAt must be counted with its counter-leg.
 */
function existedAt(sql: Db, readAt: Date) {
  return sql`(created_at <= ${readAt} OR EXISTS (
    SELECT 1 FROM ledger_entries e JOIN ledger_tx t ON t.id = e.tx_id WHERE e.account_id = accounts.id AND t.posted_at <= ${readAt}
  ))`;
}

async function accountsInSet(sql: Db, accountSet: ReconciliationAccountSet, readAt: Date): Promise<AccountHit[]> {
  if (accountSet.mode === 'explicit') {
    return sql<AccountHit[]>`
      SELECT id, asset_id FROM accounts
       WHERE ${existedAt(sql, readAt)} AND id = ANY(${accountSet.accountIds}::uuid[])
    `;
  }
  if (accountSet.mode === 'all') {
    return sql<AccountHit[]>`SELECT id, asset_id FROM accounts WHERE ${existedAt(sql, readAt)}`;
  }
  const prefix = accountSet.ownerIdPrefix ? likePrefix(accountSet.ownerIdPrefix) : null;
  return sql<AccountHit[]>`
    SELECT id, asset_id FROM accounts
     WHERE ${existedAt(sql, readAt)}
       ${accountSet.rail ? sql`AND owner_type = 'treasury'::owner_type AND owner_id = ${`rail:${accountSet.rail}`}` : sql``}
       ${accountSet.ownerType ? sql`AND owner_type = ${accountSet.ownerType}::owner_type` : sql``}
       ${prefix ? sql`AND owner_id LIKE ${prefix} ESCAPE '\\'` : sql``}
       ${accountSet.kind ? sql`AND kind = ${accountSet.kind}::account_kind` : sql``}
       ${accountSet.purpose !== undefined ? sql`AND purpose = ${accountSet.purpose}` : sql``}
       ${accountSet.assetId ? sql`AND asset_id = ${accountSet.assetId}` : sql``}
  `;
}

async function balancesAt(sql: Db, ids: string[], readAt: Date): Promise<Map<string, Amount>> {
  const out = new Map<string, Amount>();
  for (const id of ids) out.set(id, 0n);
  if (ids.length === 0) return out;
  const rows = await sql<Array<{ account_id: string; balance_after: string }>>`
    SELECT DISTINCT ON (e.account_id) e.account_id, e.balance_after::text AS balance_after
      FROM ledger_entries e
      JOIN ledger_tx t ON t.id = e.tx_id
     WHERE e.account_id = ANY(${ids}::uuid[]) AND t.posted_at <= ${readAt}
     ORDER BY e.account_id, e.id DESC
  `;
  for (const row of rows) out.set(row.account_id, parseAmount(row.balance_after));
  return out;
}

/** The cached balance column, read for a run at the current instant only (it has no history). */
async function cachedBalances(sql: Db, ids: string[]): Promise<Map<string, Amount>> {
  const out = new Map<string, Amount>();
  for (const id of ids) out.set(id, 0n);
  if (ids.length === 0) return out;
  const rows = await sql<Array<{ id: string; balance: string }>>`
    SELECT id, balance::text AS balance FROM accounts WHERE id = ANY(${ids}::uuid[])
  `;
  for (const row of rows) out.set(row.id, parseAmount(row.balance));
  return out;
}

interface Book {
  accounts: AccountHit[];
  accountIds: string[];
  /** Each account's last balance_after at readAt: the ledger side of every total. */
  balances: Map<string, Amount>;
  /** Each account's entries summed up to readAt. */
  replayed: Map<string, Amount>;
  /**
   * A replay at the current instant only: the cached balance column and every entry the same snapshot shows, per
   * account. Their equality holds at every instant, so it is checked on the snapshot itself (the cached column has no
   * history to read at readAt).
   */
  drift?: { cached: Map<string, Amount>; replayed: Map<string, Amount> };
}

class BookReadError extends Error {
  constructor(
    readonly phase: 'accounts' | 'ledger',
    readonly accountIds: string[],
    options: { cause: unknown },
  ) {
    super(`reconciliation book read failed at ${phase}`, options);
  }
}

/**
 * The account set, the ledger side and the replay side at readAt, from one repeatable-read snapshot, for a past run and
 * a run at the current instant alike. An account created and funded after readAt is in no side, and its counter-leg's
 * later balance is not counted either: never one leg without the other, and every total matches the run's read_at and
 * the outside source read at it. A run at the current instant also reads the cached column against the snapshot's
 * entries (Book.drift) when the check replays. A chain check reads the set only, outside a transaction.
 */
async function readBook(
  sql: Db,
  accountSet: ReconciliationAccountSet,
  readAt: Date,
  past: boolean,
  withBalances: boolean,
  replays: boolean,
): Promise<Book> {
  const read = async (db: Db): Promise<Book> => {
    let accounts: AccountHit[];
    try {
      accounts = await accountsInSet(db, accountSet, readAt);
    } catch (err) {
      throw new BookReadError('accounts', [], { cause: err });
    }
    const accountIds = accounts.map((account) => account.id).sort();
    if (!withBalances) return { accounts, accountIds, balances: new Map(), replayed: new Map() };
    try {
      const balances = await balancesAt(db, accountIds, readAt);
      const replayed = replays ? await replayedAt(db, accountIds, readAt) : new Map<string, Amount>();
      if (past || !replays) return { accounts, accountIds, balances, replayed };
      const drift = { cached: await cachedBalances(db, accountIds), replayed: await replayedAt(db, accountIds, null) };
      return { accounts, accountIds, balances, replayed, drift };
    } catch (err) {
      throw new BookReadError('ledger', accountIds, { cause: err });
    }
  };
  if (withBalances && 'begin' in sql && typeof sql.begin === 'function') {
    try {
      return (await (sql as Sql).begin('isolation level repeatable read read only', (tx) => read(tx))) as Book;
    } catch (err) {
      // Opening or closing the snapshot failed: the database is the source that did not answer.
      throw err instanceof BookReadError ? err : new BookReadError('ledger', [], { cause: err });
    }
  }
  return read(sql);
}

/** Each account's entries summed up to readAt, or every entry the snapshot shows when readAt is null. */
async function replayedAt(sql: Db, ids: string[], readAt: Date | null): Promise<Map<string, Amount>> {
  const out = new Map<string, Amount>();
  for (const id of ids) out.set(id, 0n);
  if (ids.length === 0) return out;
  const rows = await sql<Array<{ account_id: string; replayed: string }>>`
    SELECT e.account_id,
           COALESCE(SUM(CASE WHEN e.direction = 'debit' THEN e.amount ELSE -e.amount END), 0)::text AS replayed
      FROM ledger_entries e
      JOIN ledger_tx t ON t.id = e.tx_id
     WHERE e.account_id = ANY(${ids}::uuid[]) ${readAt ? sql`AND t.posted_at <= ${readAt}` : sql``}
     GROUP BY e.account_id
  `;
  for (const row of rows) out.set(row.account_id, parseAmount(row.replayed));
  return out;
}

function toleranceFor(tolerance: ToleranceStored | null, assetId: string): Amount | null {
  const raw = tolerance?.byAsset?.[assetId] ?? tolerance?.default;
  if (raw === undefined || raw.trim() === '') return null;
  return parseAmount(raw);
}

function sumByAsset(accounts: AccountHit[], amounts: Map<string, Amount>): Map<string, Amount> {
  const totals = new Map<string, Amount>();
  for (const account of accounts) {
    totals.set(account.asset_id, (totals.get(account.asset_id) ?? 0n) + (amounts.get(account.id) ?? 0n));
  }
  return totals;
}

function assetRow(
  assetId: string,
  observed: Amount,
  expected: Amount | 'unset',
  tolerance: Amount | null,
  pass: boolean | 'unset',
): AssetEvidence {
  if (expected === 'unset' || tolerance === null || pass === 'unset') {
    return {
      assetId,
      observed: formatAmount(observed),
      expected: 'unset',
      difference: 'unset',
      tolerance: tolerance === null ? 'unset' : formatAmount(tolerance),
    };
  }
  return {
    assetId,
    observed: formatAmount(observed),
    expected: formatAmount(expected),
    difference: formatAmount(observed - expected),
    tolerance: formatAmount(tolerance),
  };
}

function foldAssets(assets: AssetEvidence[], unsetSource: boolean): 'PASS' | 'FAIL' | 'ERROR' | 'UNSET' {
  if (assets.some((asset) => asset.tolerance === 'unset')) return 'ERROR';
  if (unsetSource || assets.some((asset) => asset.expected === 'unset')) return 'UNSET';
  if (assets.some((asset) => asset.difference !== 'unset' && parseAmount(asset.difference) !== 0n && !withinStored(asset))) return 'FAIL';
  return 'PASS';
}

function withinStored(asset: AssetEvidence): boolean {
  if (asset.difference === 'unset' || asset.tolerance === 'unset') return false;
  const difference = parseAmount(asset.difference);
  const abs = difference < 0n ? -difference : difference;
  return abs <= parseAmount(asset.tolerance);
}

function withDrift(rows: AssetEvidence[], book: Book, tolerance: ToleranceStored | null): AssetEvidence[] {
  const drift = book.drift;
  if (!drift) return rows;
  const drifted = new Map<string, Amount>();
  for (const account of book.accounts) {
    const difference = (drift.cached.get(account.id) ?? 0n) - (drift.replayed.get(account.id) ?? 0n);
    const abs = difference < 0n ? -difference : difference;
    const tol = toleranceFor(tolerance, account.asset_id);
    if (tol !== null && abs > tol) drifted.set(account.asset_id, (drifted.get(account.asset_id) ?? 0n) + abs);
  }
  if (drifted.size === 0) return rows;
  const out = rows.filter((asset) => !drifted.has(asset.assetId));
  for (const [assetId, abs] of drifted) out.push(assetRow(assetId, abs, 0n, toleranceFor(tolerance, assetId), false));
  return out.sort((a, b) => (a.assetId < b.assetId ? -1 : 1));
}

function equalAssets(
  observed: Map<string, Amount>,
  expected: Map<string, Amount>,
  tolerance: ToleranceStored | null,
  missingIsZero: boolean,
): AssetEvidence[] {
  const ids = new Set<string>([...observed.keys(), ...expected.keys()]);
  const assets: AssetEvidence[] = [];
  for (const assetId of [...ids].sort()) {
    const left = observed.get(assetId);
    const right = expected.get(assetId);
    const seenLeft = left ?? (missingIsZero ? 0n : null);
    const seenRight = right ?? (missingIsZero ? 0n : null);
    const tol = toleranceFor(tolerance, assetId);
    if (seenLeft === null || seenRight === null) {
      assets.push(assetRow(assetId, seenLeft ?? 0n, 'unset', tol, 'unset'));
      continue;
    }
    const difference = seenLeft - seenRight;
    const abs = difference < 0n ? -difference : difference;
    const pass = tol !== null && abs <= tol;
    assets.push(assetRow(assetId, seenLeft, seenRight, tol, pass));
  }
  return assets;
}

function thresholdAssets(
  observed: Map<string, Amount>,
  threshold: ReconciliationThreshold,
  tolerance: ToleranceStored | null,
): AssetEvidence[] {
  const assets: AssetEvidence[] = [];
  for (const assetId of Object.keys(threshold.byAsset).sort()) {
    const bound = parseAmount(threshold.byAsset[assetId] ?? '0');
    const amount = observed.get(assetId) ?? 0n;
    const tol = toleranceFor(tolerance, assetId);
    if (tol === null) {
      assets.push(assetRow(assetId, amount, bound, null, 'unset'));
      continue;
    }
    const pass = threshold.bound === 'min' ? amount + tol >= bound : amount - tol <= bound;
    const difference = threshold.bound === 'min' ? (amount < bound ? amount - bound : 0n) : amount > bound ? amount - bound : 0n;
    assets.push({
      assetId,
      observed: formatAmount(amount),
      expected: formatAmount(bound),
      difference: formatAmount(difference),
      tolerance: formatAmount(tol),
    });
    if (!pass && difference === 0n) {
      assets[assets.length - 1] = {
        assetId,
        observed: formatAmount(amount),
        expected: formatAmount(bound),
        difference: formatAmount(amount - bound),
        tolerance: formatAmount(tol),
      };
    }
  }
  return assets;
}

/** Read the book once (readBook) and judge it; the account ids are the ones the verdict counted, stored as its evidence. */
async function evaluate(
  sql: Db,
  row: ControlRow,
  readAt: Date,
  sources: ReconciliationSources,
  past: boolean,
): Promise<{ verdict: Verdict; accountIds: string[] }> {
  const accountSet = reconciliationAccountSetSchema.parse(row.account_set);
  let book: Book;
  try {
    const replays = row.template === 'ledger_invariant' && (row.check_kind === 'replay' || row.check_kind === 'replay_and_netting');
    book = await readBook(sql, accountSet, readAt, past, row.check_kind !== 'chain', replays);
  } catch (err) {
    if (err instanceof BookReadError) return { verdict: unavailableVerdict(err.phase, readAt), accountIds: err.accountIds };
    return { verdict: unavailableVerdict('accounts', readAt), accountIds: [] };
  }
  return { verdict: await judge(sql, row, accountSet, book, readAt, sources, past), accountIds: book.accountIds };
}

async function judge(
  sql: Db,
  row: ControlRow,
  accountSet: ReconciliationAccountSet,
  book: Book,
  readAt: Date,
  sources: ReconciliationSources,
  past: boolean,
): Promise<Verdict> {
  const emptySources: ReconciliationControlRunView['sources'] = {
    ledger: { asOf: readAt.toISOString() },
    outside: { asOf: 'unset' },
    parity: { asOf: 'unset' },
  };

  if (row.check_kind === 'chain') {
    try {
      const chain = await verifyChain(sql, 1000, past ? readAt : undefined);
      return {
        status: chain.ok ? 'PASS' : 'FAIL',
        phase: chain.ok ? '' : 'chain',
        errorCode: '',
        assets: [],
        outsideSide: 'not_applicable',
        sources: emptySources,
      };
    } catch {
      return {
        status: 'ERROR',
        phase: 'chain',
        errorCode: LEDGER_RECONCILE_SOURCE_UNAVAILABLE,
        assets: [],
        outsideSide: 'not_applicable',
        sources: emptySources,
      };
    }
  }

  const ledgerTotals = sumByAsset(book.accounts, book.balances);

  if (row.template === 'ledger_invariant' && (row.check_kind === 'replay' || row.check_kind === 'replay_and_netting')) {
    // Each account's last balance_after against its entries at readAt. At the current instant the cached column is also
    // checked against the snapshot's entries account by account (drift on two accounts cannot cancel); an asset with a
    // drifting account fails, its row observing the summed size of each account's drift against 0.
    const replayRows = withDrift(
      equalAssets(ledgerTotals, sumByAsset(book.accounts, book.replayed), row.tolerance, true),
      book,
      row.tolerance,
    );
    let assets = replayRows;
    if (row.check_kind === 'replay_and_netting' && accountSet.mode === 'all') {
      const zeros = new Map<string, Amount>();
      for (const assetId of ledgerTotals.keys()) zeros.set(assetId, 0n);
      const netRows = equalAssets(ledgerTotals, zeros, row.tolerance, true);
      if (foldAssets(replayRows, false) === 'PASS') assets = netRows;
    }
    const status = foldAssets(assets, false);
    return {
      status,
      phase: status === 'ERROR' ? 'tolerance' : status === 'FAIL' ? 'invariant' : '',
      errorCode: status === 'ERROR' ? OPS_CONTROL_POLICY_UNSET : '',
      assets,
      outsideSide: 'not_applicable',
      sources: emptySources,
    };
  }

  if (row.check_kind === 'netting') {
    const zeros = new Map<string, Amount>();
    for (const assetId of ledgerTotals.keys()) zeros.set(assetId, 0n);
    const assets = equalAssets(ledgerTotals, zeros, row.tolerance, true);
    const status = foldAssets(assets, false);
    return {
      status,
      phase: status === 'FAIL' ? 'netting' : status === 'ERROR' ? 'tolerance' : '',
      errorCode: status === 'ERROR' ? OPS_CONTROL_POLICY_UNSET : '',
      assets,
      outsideSide: 'not_applicable',
      sources: emptySources,
    };
  }

  if (row.template === 'threshold') {
    let threshold: ReconciliationThreshold;
    try {
      threshold = reconciliationThresholdSchema.parse(row.threshold);
    } catch {
      return {
        status: 'ERROR',
        phase: 'threshold',
        errorCode: OPS_CONTROL_POLICY_UNSET,
        assets: [],
        outsideSide: 'not_applicable',
        sources: emptySources,
      };
    }
    const assets = thresholdAssets(ledgerTotals, threshold, row.tolerance);
    const status = assets.some((asset) => asset.tolerance === 'unset')
      ? 'ERROR'
      : assets.some((asset) => asset.difference !== 'unset' && parseAmount(asset.difference) !== 0n && !withinStored(asset))
        ? 'FAIL'
        : 'PASS';
    return {
      status,
      phase: status === 'FAIL' ? 'threshold' : status === 'ERROR' ? 'tolerance' : '',
      errorCode: status === 'ERROR' ? OPS_CONTROL_POLICY_UNSET : '',
      assets,
      outsideSide: 'not_applicable',
      sources: emptySources,
    };
  }

  const outsideTemplate = row.template === 'outside_balance';
  // A control over one rail's boundary reads that rail's statement only.
  const rail = accountSet.mode === 'query' ? accountSet.rail : undefined;
  let read: SnapshotRead;
  try {
    read = outsideTemplate ? await sources.outsideBalance(readAt, rail) : await sources.parity(readAt);
  } catch {
    read = { kind: 'unavailable' };
  }
  const side = outsideTemplate ? 'outside' : 'parity';
  if (read.kind === 'unavailable') {
    return {
      status: 'ERROR',
      phase: side,
      errorCode: LEDGER_RECONCILE_SOURCE_UNAVAILABLE,
      assets: [],
      outsideSide: outsideTemplate ? 'unavailable' : 'not_applicable',
      sources: {
        ...emptySources,
        [side]: { asOf: 'unset' },
      },
    };
  }
  if (read.kind === 'unset') {
    const assets: AssetEvidence[] = [...ledgerTotals.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([assetId, amount]) => ({
        assetId,
        observed: formatAmount(amount),
        expected: 'unset',
        difference: 'unset',
        tolerance: (() => {
          const tol = toleranceFor(row.tolerance, assetId);
          return tol === null ? 'unset' : formatAmount(tol);
        })(),
      }));
    return {
      status: 'UNSET',
      phase: side,
      errorCode: outsideTemplate && rail !== undefined ? LEDGER_RECONCILE_RAIL_SOURCE_UNSET : '',
      assets,
      outsideSide: outsideTemplate ? 'unset' : 'not_applicable',
      sources: emptySources,
    };
  }
  const expected = new Map<string, Amount>();
  for (const balance of read.balances ?? []) expected.set(balance.assetId, parseAmount(balance.amount));
  const nextSources: ReconciliationControlRunView['sources'] = {
    ...emptySources,
    // A snapshot that names no as-of stays unset: its age is unknown, and the ledger's time is not its time.
    [side]: { asOf: read.asOf ?? 'unset' },
  };
  const assets = equalAssets(ledgerTotals, expected, row.tolerance, !outsideTemplate);
  const unsetSource = outsideTemplate && assets.some((asset) => asset.expected === 'unset');
  const status = foldAssets(assets, unsetSource);
  return {
    status: status === 'PASS' || status === 'FAIL' || status === 'ERROR' || status === 'UNSET' ? status : 'ERROR',
    phase: status === 'FAIL' ? side : status === 'ERROR' ? 'tolerance' : '',
    errorCode: status === 'ERROR' ? OPS_CONTROL_POLICY_UNSET : '',
    assets,
    outsideSide: outsideTemplate ? 'snapshot' : 'not_applicable',
    sources: nextSources,
  };
}

interface RunRow {
  id: string;
  control_id: string;
  status: ReconciliationControlRunView['status'];
  phase: string;
  error_code: string;
  as_of: Date;
  read_at: Date;
  margin: string;
  sources: ReconciliationControlRunView['sources'];
  evidence: { accounts?: string[]; assets?: AssetEvidence[] };
  outside_side: ReconciliationControlRunView['outsideSide'];
  period_start: Date;
  period_end: Date;
  accounts?: string[];
}

function toRun(row: RunRow): ReconciliationControlRunView {
  const margin = row.margin === 'unset' ? { status: 'unset' as const } : { status: 'set' as const, value: row.margin };
  return reconciliationControlRunSchema.parse({
    id: row.id,
    controlId: row.control_id,
    status: row.status,
    phase: row.phase ? { status: 'set', value: row.phase } : { status: 'unset' },
    errorCode: row.error_code ? { status: 'set', value: row.error_code } : { status: 'unset' },
    asOf: row.as_of.toISOString(),
    readAt: row.read_at.toISOString(),
    margin,
    sources: row.sources,
    outsideSide: row.outside_side,
    periodStart: row.period_start.toISOString(),
    periodEnd: row.period_end.toISOString(),
    accounts: row.evidence.accounts ?? [],
    assets: row.evidence.assets ?? [],
  });
}

const RUN_COLUMNS = `
  id, control_id, status, phase, error_code, as_of, read_at, margin, sources, evidence, outside_side, period_start, period_end
`;
/** The same columns read through the alias `r`, for a join. */
const RUN_COLUMNS_AS_R = RUN_COLUMNS.split(',')
  .map((column) => `r.${column.trim()}`)
  .join(', ');

function isUniqueViolation(err: unknown, depth = 0): boolean {
  if (!err || typeof err !== 'object' || depth > 3) return false;
  if ((err as { code?: unknown }).code === '23505') return true;
  const cause = (err as { cause?: unknown }).cause;
  return cause !== undefined && cause !== err && isUniqueViolation(cause, depth + 1);
}

/** A started row is the only one a later pass may finish. A terminal row is returned as stored. */
async function finishRun(sql: Db, runId: string, verdict: Verdict, accountIds: string[]): Promise<RunRow> {
  const rows = await sql<RunRow[]>`
    UPDATE reconciliation_control_runs
       SET status = ${verdict.status},
           phase = ${verdict.phase},
           error_code = ${verdict.errorCode},
           sources = ${sql.json(verdict.sources)},
           evidence = ${sql.json(asJson({ accounts: accountIds, assets: verdict.assets }))},
           outside_side = ${verdict.outsideSide},
           finished_at = clock_timestamp()
     WHERE id = ${runId} AND status = 'started'
     RETURNING ${sql.unsafe(RUN_COLUMNS)}
  `;
  if (rows[0]) return rows[0];
  const current = await sql<RunRow[]>`
    SELECT ${sql.unsafe(RUN_COLUMNS)}
      FROM reconciliation_control_runs
     WHERE id = ${runId}
  `;
  const row = current[0];
  if (row && row.status !== 'started') return row;
  throw new ReconciliationControlError(LEDGER_RECONCILE_SOURCE_UNAVAILABLE);
}

function unavailableVerdict(phase: string, readAt: Date): Verdict {
  return {
    status: 'ERROR',
    phase,
    errorCode: LEDGER_RECONCILE_SOURCE_UNAVAILABLE,
    assets: [],
    outsideSide: 'not_applicable',
    sources: {
      ledger: { asOf: readAt.toISOString() },
      outside: { asOf: 'unset' },
      parity: { asOf: 'unset' },
    },
  };
}

/**
 * Finish a started row. A throw from the account read or from evaluate is stored as ERROR
 * with that phase, so the same operation id does not stay `started` forever.
 */
async function resumeRun(
  sql: Sql,
  row: ControlRow,
  opened: RunRow,
  sources: ReconciliationSources,
  past: boolean,
): Promise<ReconciliationControlRunView> {
  let phase = 'accounts';
  try {
    reconciliationAccountSetSchema.parse(row.account_set);
    phase = 'evaluate';
    const { verdict, accountIds } = await evaluate(sql, row, opened.read_at, sources, past);
    return toRun(await finishRun(sql, opened.id, verdict, accountIds));
  } catch {
    return toRun(await finishRun(sql, opened.id, unavailableVerdict(phase, opened.read_at), []));
  }
}

async function openRun(
  sql: Sql,
  row: ControlRow,
  actor: ControlActor,
  reason: string,
  operationId: string,
  fp: string,
  asOf: Date,
  readAt: Date,
  margin: string,
  period: { start: Date; end: Date },
): Promise<RunRow> {
  const sources: ReconciliationControlRunView['sources'] = {
    ledger: { asOf: readAt.toISOString() },
    outside: { asOf: 'unset' },
    parity: { asOf: 'unset' },
  };
  return sql.begin(async (tx) => {
    // A pause or retire that committed after the caller read the control wins: no new run opens on it.
    // FOR SHARE holds off a lifecycle move (FOR UPDATE) until this run row is in.
    const [live] = await tx<Array<{ state: ControlRow['state'] }>>`
      SELECT state FROM reconciliation_controls WHERE id = ${row.id} FOR SHARE
    `;
    if (live?.state !== 'active') throw new ReconciliationControlError(OPS_CONTROL_STATE_ILLEGAL);
    const inserted = await tx<RunRow[]>`
      INSERT INTO reconciliation_control_runs (
        control_id, operation_id, fingerprint, status, phase, error_code, as_of, read_at, margin, sources, evidence,
        outside_side, period_start, period_end, actor_id, reason
      ) VALUES (
        ${row.id},
        ${operationId},
        ${fp},
        'started',
        '',
        '',
        ${asOf},
        ${readAt},
        ${margin},
        ${tx.json(sources)},
        ${tx.json({ accounts: [], assets: [] })},
        'not_applicable',
        ${period.start},
        ${period.end},
        ${actorOf(actor.actorId)},
        ${reason}
      )
      RETURNING ${tx.unsafe(RUN_COLUMNS)}
    `;
    const run = inserted[0];
    if (!run) throw new ReconciliationControlError(LEDGER_RECONCILE_SOURCE_UNAVAILABLE);
    await audit(tx, row.id, actorOf(actor.actorId), reason, 'run', actor.requestId, { runId: run.id, operationId });
    return run;
  });
}

async function existingRun(sql: Sql, operationId: string): Promise<(RunRow & { fingerprint: string }) | null> {
  const rows = await sql<Array<RunRow & { fingerprint: string }>>`
    SELECT ${sql.unsafe(RUN_COLUMNS)}, fingerprint
      FROM reconciliation_control_runs
     WHERE operation_id = ${operationId}
  `;
  return rows[0] ?? null;
}

export async function runReconciliationControl(
  sql: Sql,
  approvals: LedgerApprovalConsumer,
  actor: ControlActor,
  input: unknown,
  sources: ReconciliationSources = unsetReconciliationSources(),
  now?: Date,
): Promise<ReconciliationControlRunView> {
  const parsed = runReconciliationControlInputSchema.parse(input);
  if (parsed.operationId.startsWith(SCHEDULE_OPERATION_PREFIX)) throw new ReconciliationControlError('ledger.idempotency_conflict');
  const who = actorOf(actor.actorId);
  const reason = reasonOf(parsed.reason);
  const row = await loadControl(sql, parsed.controlId, false);
  const [clock] = await sql<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
  const dbNow = now ?? clock?.now;
  if (!dbNow) throw new ReconciliationControlError(LEDGER_RECONCILE_SOURCE_UNAVAILABLE);
  const past = parsed.asOf !== undefined;
  const asOf = past ? new Date(parsed.asOf ?? '') : dbNow;
  if (Number.isNaN(asOf.getTime())) throw new ReconciliationControlError(LEDGER_RECONCILE_ASOF_INVALID);
  assertNotFuture(asOf, dbNow);
  let margin = 'unset';
  let readAt = asOf;
  if (past) {
    const chosen = parsed.margin ?? row.margin ?? undefined;
    if (!present(chosen) || chosen.trim() === '') throw new ReconciliationControlError(OPS_CONTROL_MARGIN_UNSET);
    margin = chosen.trim();
    readAt = readInstant(asOf, margin);
  }
  const fp = fingerprint({
    controlId: row.id,
    asOf: past ? asOf.toISOString() : 'now',
    margin,
    reason,
  });
  const prior = await existingRun(sql, parsed.operationId);
  if (prior) {
    if (prior.fingerprint !== fp) throw new ReconciliationControlError('ledger.idempotency_conflict');
    if (prior.status !== 'started') return toRun(prior);
    // A run that already opened finishes even if the control was paused or retired since: its row exists and must end.
    return resumeRun(sql, row, prior, sources, past);
  }
  // A new run needs an active control. A stored or started run for this operation is answered above, after a pause too.
  if (row.state !== 'active') throw new ReconciliationControlError(OPS_CONTROL_STATE_ILLEGAL);
  // operationId is the consume request id, so a retry after a lost reply is
  // `already_consumed_by_this_request` and can still insert or resume this run.
  await consumeLedgerApproval(
    approvals,
    parsed,
    'ledger.reconciliation_control.run',
    'posting_reconciliation_control.run',
    String(row.version),
    {
      controlId: row.id,
      asOf: past ? asOf.toISOString() : 'now',
      margin,
      reason,
    },
    parsed.operationId,
    who,
  );
  return openOrResumeRun(
    sql,
    row,
    { actorId: who, requestId: actor.requestId },
    reason,
    parsed.operationId,
    fp,
    asOf,
    readAt,
    margin,
    past,
    sources,
  );
}

async function openOrResumeRun(
  sql: Sql,
  row: ControlRow,
  actor: ControlActor,
  reason: string,
  operationId: string,
  fp: string,
  asOf: Date,
  readAt: Date,
  margin: string,
  past: boolean,
  sources: ReconciliationSources,
): Promise<ReconciliationControlRunView> {
  const adopt = async (existing: RunRow & { fingerprint: string }): Promise<ReconciliationControlRunView> => {
    if (existing.fingerprint !== fp) throw new ReconciliationControlError('ledger.idempotency_conflict');
    if (existing.status !== 'started') return toRun(existing);
    return resumeRun(sql, row, existing, sources, past);
  };
  const found = await existingRun(sql, operationId);
  if (found) return adopt(found);
  const schedule = row.schedule ? reconciliationScheduleSchema.parse(row.schedule) : null;
  const periodName = row.period ?? (schedule ? periodForSchedule(schedule) : null);
  if (!periodName) throw new ReconciliationControlError(OPS_CONTROL_POLICY_UNSET);
  const period = periodBounds(periodName, readAt);
  try {
    const opened = await openRun(sql, row, actor, reason, operationId, fp, asOf, readAt, margin, period);
    return resumeRun(sql, row, opened, sources, past);
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const raced = await existingRun(sql, operationId);
    if (!raced) throw err;
    return adopt(raced);
  }
}

export async function runDueControls(sql: Sql, sources: ReconciliationSources = unsetReconciliationSources()): Promise<void> {
  const [clock] = await sql<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
  const at = clock?.now;
  if (!at) throw new ReconciliationControlError(LEDGER_RECONCILE_SOURCE_UNAVAILABLE);
  const rows = await sql<ControlRow[]>`
    SELECT ${sql.unsafe(CONTROL_COLUMNS)}
      FROM reconciliation_controls
     WHERE builtin = false AND state = 'active' AND schedule IS NOT NULL
  `;
  for (const row of rows) {
    // One control that throws must not stop the others: its period stays unrun and the next tick retries it.
    try {
      const schedule = reconciliationScheduleSchema.parse(row.schedule);
      const periodName = row.period ?? periodForSchedule(schedule);
      const current = periodBounds(periodName, at);
      // The period before this one too, so a due instant no tick landed after (a short window late in a period)
      // is caught up on the next tick instead of being skipped.
      const previous = periodBounds(periodName, new Date(current.start.getTime() - 1));
      for (const bounds of [previous, current]) await runScheduledPeriod(sql, row, schedule, bounds, at, sources);
    } catch (err) {
      console.error(
        JSON.stringify({
          level: 'error',
          service: 'svc-ledger',
          event: 'ledger.reconciliation_control.schedule_failed',
          controlId: row.id,
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }
}

async function runScheduledPeriod(
  sql: Sql,
  row: ControlRow,
  schedule: ReturnType<typeof reconciliationScheduleSchema.parse>,
  bounds: ReturnType<typeof periodBounds>,
  at: Date,
  sources: ReconciliationSources,
): Promise<void> {
  const due = dueInstant(schedule, bounds.start);
  if (!due || at.getTime() < due.getTime()) return;
  // A period that fell due while the control was paused is not caught up on resume.
  if (row.resumed_at && due.getTime() < row.resumed_at.getTime()) return;
  const operationId = `${SCHEDULE_OPERATION_PREFIX}${row.id}:${bounds.start.toISOString()}`;
  const existing = await existingRun(sql, operationId);
  // A terminal row for this period is done. A started row is a crash between open and finish: resume it.
  if (existing && existing.status !== 'started') return;
  if (existing) {
    await resumeScheduled(sql, row, existing, sources);
    return;
  }
  const margin = row.margin;
  if (margin === null || margin.trim() === '') {
    const opened = await openRun(
      sql,
      row,
      { actorId: 'reconciliation', requestId: null },
      'scheduled reconciliation control',
      operationId,
      fingerprint({ controlId: row.id, asOf: due.toISOString(), margin: 'unset', reason: 'scheduled reconciliation control' }),
      due,
      due,
      'unset',
      bounds,
    );
    await finishRun(
      sql,
      opened.id,
      {
        status: 'ERROR',
        phase: 'margin',
        errorCode: OPS_CONTROL_MARGIN_UNSET,
        assets: [],
        outsideSide: 'not_applicable',
        sources: {
          ledger: { asOf: due.toISOString() },
          outside: { asOf: 'unset' },
          parity: { asOf: 'unset' },
        },
      },
      [],
    );
    return;
  }
  const readAt = readInstant(due, margin);
  const fp = fingerprint({
    controlId: row.id,
    asOf: due.toISOString(),
    margin,
    reason: 'scheduled reconciliation control',
  });
  // The run belongs to the period it is due in, even when the margin reads from just before that period.
  const opened = await openRun(
    sql,
    row,
    { actorId: 'reconciliation', requestId: null },
    'scheduled reconciliation control',
    operationId,
    fp,
    due,
    readAt,
    margin,
    bounds,
  );
  await resumeRun(sql, row, opened, sources, true);
}

async function resumeScheduled(sql: Sql, row: ControlRow, existing: RunRow, sources: ReconciliationSources): Promise<void> {
  const margin = row.margin;
  if ((margin === null || margin.trim() === '') && existing.margin === 'unset') {
    await finishRun(
      sql,
      existing.id,
      {
        status: 'ERROR',
        phase: 'margin',
        errorCode: OPS_CONTROL_MARGIN_UNSET,
        assets: [],
        outsideSide: 'not_applicable',
        sources: {
          ledger: { asOf: existing.read_at.toISOString() },
          outside: { asOf: 'unset' },
          parity: { asOf: 'unset' },
        },
      },
      [],
    );
    return;
  }
  await resumeRun(sql, row, existing, sources, true);
}

export async function runDueReconciliationControls(sql: Sql, sources: ReconciliationSources = unsetReconciliationSources()): Promise<void> {
  await runDueControls(sql, sources);
}
