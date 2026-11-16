/**
 * HALT ONE STRATEGY OR EVERY STRATEGY (J-algo-dev-11; AL-live-04, AL-limits-01). The risk desk's control over live
 * strategy runs (live-runs.ts), for founders on the console's /more-ops/quant.
 *
 *   · the desk: every live run of every person, with its owner, state, version and halt; the halts standing; the
 *     requests waiting for a second founder; and the audit rows (`trade.operator_audit`, kind `quant_live.*`);
 *   · halt one strategy (`halt`): one operator with a reason. The strategy's runs place no new order and a new run of
 *     it is refused, while a reduce-only exit (Liquidate) still passes. Its audit row names the operator;
 *   · halt every strategy (`propose` op `halt_all`, then `confirm`): the first founder records a request bound to their
 *     identity approval and nothing is halted; a second founder confirms it, which consumes the approval once and halts
 *     every strategy with a live run at that moment, answering how many runs it halted;
 *   · restore (`propose` op `restore` for one halt or `restore_all` for every halt, then `confirm`): the same two-person
 *     rule, and an audit row naming both founders.
 *
 * Nothing here holds or moves money and no ledger recipe is imported: a halt places, cancels and closes nothing; the
 * person's position stays in their own venue sub-account, which only their wallet controls.
 */
import { createHash } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import type { Principal } from '@intafaced/auth';
import {
  TradeOpsError,
  consumeApproval,
  payloadHash,
  requireOperator,
  requireOperatorWrite,
  requireReason,
  writeOperatorAudit,
  type ApprovalBook,
} from '../../admin/common.js';
import type { LiveRunState } from './store.js';

export const QUANT_HALT_ALL_ACTION = 'trade.quant_live_halt_all' as const;
export const QUANT_RESTORE_ACTION = 'trade.quant_live_restore' as const;
export const QUANT_RESTORE_ALL_ACTION = 'trade.quant_live_restore_all' as const;

export type HaltOp = 'halt_all' | 'restore' | 'restore_all';

/** Where a run is live: it may place an order, or will once its wallet signs. */
export const LIVE_STATES: readonly LiveRunState[] = ['signing', 'running', 'unknown'];

export interface HaltView {
  readonly id: string;
  readonly userId: string;
  readonly strategyId: string;
  readonly scope: 'one' | 'all';
  readonly reason: string;
  readonly haltedBy: string;
  readonly haltApprover: string | null;
  readonly haltedAt: string;
}

export interface HaltRequestView {
  readonly id: string;
  readonly op: HaltOp;
  readonly haltId: string | null;
  readonly userId: string | null;
  readonly strategyId: string | null;
  readonly reason: string;
  readonly status: 'awaiting_second' | 'applied';
  readonly approvalId: string;
  readonly proposedBy: string;
  readonly approverId: string | null;
  readonly confirmedBy: string | null;
  readonly appliedRuns: number | null;
  readonly appliedStrategies: number | null;
  readonly requestedAt: string;
  readonly decidedAt: string | null;
}

export interface DeskRunView {
  readonly runId: string;
  readonly userId: string;
  readonly owner: string;
  readonly subAccount: string;
  readonly strategyId: string;
  readonly strategyName: string;
  readonly strategyVersion: number;
  readonly state: LiveRunState;
  readonly createdAt: string;
  readonly halt: HaltView | null;
}

export interface AuditView {
  readonly id: string;
  readonly kind: string;
  readonly operatorId: string;
  readonly approverId: string | null;
  readonly accountId: string | null;
  readonly objectId: string;
  readonly reason: string | null;
  readonly occurredAt: string;
  readonly detail: Record<string, unknown>;
}

export interface HaltDeskView {
  readonly runs: readonly DeskRunView[];
  readonly halts: readonly HaltView[];
  readonly waiting: readonly HaltRequestView[];
  readonly audit: readonly AuditView[];
  readonly counts: { readonly runs: number; readonly live: number; readonly haltedLive: number };
}

export interface HaltDeskDeps {
  readonly sql: Sql;
  readonly approvals: ApprovalBook;
  readonly now: () => Date;
}

interface HaltRow {
  id: string;
  user_id: string;
  strategy_id: string;
  scope: 'one' | 'all';
  reason: string;
  halted_by: string;
  halt_approver: string | null;
  halted_at: Date;
}

interface RequestRow {
  id: string;
  op: HaltOp;
  halt_id: string | null;
  user_id: string | null;
  strategy_id: string | null;
  reason: string;
  status: 'awaiting_second' | 'applied';
  approval_id: string;
  proposed_by: string;
  approver_id: string | null;
  confirmed_by: string | null;
  applied_runs: number | null;
  applied_strategies: number | null;
  created_at: Date;
  decided_at: Date | null;
}

const LIST_MAX = 500;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Every halt write takes this lock, so a halt, a halt of everything and a restore never interleave. */
const LOCK = 'quant-live-halts';

const sameUser = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

function uuid(raw: unknown, field: string): string {
  const v = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!UUID_RE.test(v)) throw new TradeOpsError('quant_halt_request_invalid', `${field} must be a uuid`);
  return v;
}

/** An id derived from a business key, so a retried write lands on the same row. */
function idFor(key: string): string {
  const h = createHash('sha256').update(key).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export const actionTypeOf = (op: HaltOp) =>
  op === 'halt_all' ? QUANT_HALT_ALL_ACTION : op === 'restore' ? QUANT_RESTORE_ACTION : QUANT_RESTORE_ALL_ACTION;

/** The state a change starts from, as the approval binds it: every strategy running, one halt standing, or some halted. */
export const expectedVersionOf = (op: HaltOp, haltId: string | null) =>
  op === 'halt_all' ? 'running' : op === 'restore' ? `halt:${haltId}` : 'halted';

/** What an approval binds: the request, its operation, the halt it lifts and its reason. The console hashes the same. */
export function haltApprovalPayload(input: { requestId: string; op: HaltOp; haltId: string | null; reason: string }) {
  return {
    actionType: actionTypeOf(input.op),
    requestId: input.requestId,
    op: input.op,
    haltId: input.haltId,
    reason: input.reason,
  };
}

function haltView(r: HaltRow): HaltView {
  return {
    id: r.id,
    userId: r.user_id,
    strategyId: r.strategy_id,
    scope: r.scope,
    reason: r.reason,
    haltedBy: r.halted_by,
    haltApprover: r.halt_approver,
    haltedAt: r.halted_at.toISOString(),
  };
}

function requestView(r: RequestRow): HaltRequestView {
  return {
    id: r.id,
    op: r.op,
    haltId: r.halt_id,
    userId: r.user_id,
    strategyId: r.strategy_id,
    reason: r.reason,
    status: r.status,
    approvalId: r.approval_id,
    proposedBy: r.proposed_by,
    approverId: r.approver_id,
    confirmedBy: r.confirmed_by,
    appliedRuns: r.applied_runs,
    appliedStrategies: r.applied_strategies,
    requestedAt: r.created_at.toISOString(),
    decidedAt: r.decided_at?.toISOString() ?? null,
  };
}

/** The halt the live runs read: what stands on one strategy now, or null. */
export interface StrategyHaltRead {
  haltOf(userId: string, strategyId: string): Promise<HaltView | null>;
}

export class StrategyHaltDesk implements StrategyHaltRead {
  constructor(private readonly deps: HaltDeskDeps) {}

  async haltOf(userId: string, strategyId: string): Promise<HaltView | null> {
    const [row] = await this.deps.sql<HaltRow[]>`
      SELECT * FROM trade.quant_live_halts
       WHERE user_id = ${userId} AND strategy_id = ${strategyId} AND restored_at IS NULL LIMIT 1`;
    return row ? haltView(row) : null;
  }

  /** The runs list, newest first, every person's; the halts standing; the requests waiting; the audit, newest first. */
  async desk(principal: Principal): Promise<HaltDeskView> {
    requireOperator(principal);
    const sql = this.deps.sql;
    const [runs, halts, waiting, audit, counts] = await Promise.all([
      sql<
        Array<{
          run_id: string;
          user_id: string;
          owner: string;
          sub_account: string;
          strategy_id: string;
          strategy_name: string;
          strategy_version: number;
          state: LiveRunState;
          created_at: Date;
        }>
      >`SELECT run_id, user_id, owner, sub_account, strategy_id, strategy_name, strategy_version, state, created_at
          FROM trade.quant_live_runs ORDER BY created_at DESC, run_id ASC LIMIT ${LIST_MAX}`,
      sql<HaltRow[]>`SELECT * FROM trade.quant_live_halts WHERE restored_at IS NULL ORDER BY halted_at ASC, id ASC LIMIT ${LIST_MAX}`,
      sql<RequestRow[]>`
        SELECT * FROM trade.quant_live_halt_requests WHERE status = 'awaiting_second' ORDER BY created_at ASC, id ASC LIMIT ${LIST_MAX}`,
      sql<
        Array<{
          id: string;
          kind: string;
          operator_id: string;
          approver_id: string | null;
          account_id: string | null;
          object_id: string;
          reason: string | null;
          occurred_at: Date;
          detail: Record<string, unknown>;
        }>
      >`SELECT id, kind, operator_id, approver_id, account_id, object_id, reason, occurred_at, detail
          FROM trade.operator_audit WHERE kind LIKE 'quant_live.%' ORDER BY occurred_at DESC, id DESC LIMIT 100`,
      sql<Array<{ runs: number; live: number; halted_live: number }>>`
        SELECT count(*)::int AS runs,
               count(*) FILTER (WHERE r.state IN ('signing', 'running', 'unknown'))::int AS live,
               count(*) FILTER (WHERE r.state IN ('signing', 'running', 'unknown') AND h.id IS NOT NULL)::int AS halted_live
          FROM trade.quant_live_runs r
          LEFT JOIN trade.quant_live_halts h
            ON h.user_id = r.user_id AND h.strategy_id = r.strategy_id AND h.restored_at IS NULL`,
    ]);
    const standing = new Map(halts.map((h) => [`${h.user_id}\u0000${h.strategy_id}`, haltView(h)]));
    return {
      runs: runs.map((r) => ({
        runId: r.run_id,
        userId: r.user_id,
        owner: r.owner,
        subAccount: r.sub_account,
        strategyId: r.strategy_id,
        strategyName: r.strategy_name,
        strategyVersion: r.strategy_version,
        state: r.state,
        createdAt: r.created_at.toISOString(),
        halt: standing.get(`${r.user_id}\u0000${r.strategy_id}`) ?? null,
      })),
      halts: halts.map(haltView),
      waiting: waiting.map(requestView),
      audit: audit.map((a) => ({
        id: a.id,
        kind: a.kind,
        operatorId: a.operator_id,
        approverId: a.approver_id,
        accountId: a.account_id,
        objectId: a.object_id,
        reason: a.reason,
        occurredAt: a.occurred_at.toISOString(),
        detail: a.detail ?? {},
      })),
      counts: { runs: counts[0]?.runs ?? 0, live: counts[0]?.live ?? 0, haltedLive: counts[0]?.halted_live ?? 0 },
    };
  }

  /** One request, for the console to check what an approval is bound to before a second founder approves it. */
  async request(principal: Principal, requestId: string): Promise<HaltRequestView> {
    requireOperator(principal);
    return requestView(await this.requestRow(this.deps.sql, uuid(requestId, 'requestId'), false));
  }

  /**
   * One operator halts one strategy of one person, with a reason. The request id is the business key: the same request
   * again answers the same halt. The strategy must have a run here; a strategy already halted refuses.
   */
  async halt(principal: Principal, input: { requestId: string; userId: string; strategyId: string; reason: string }): Promise<HaltView> {
    requireOperatorWrite(principal);
    const requestId = uuid(input.requestId, 'requestId');
    const reason = requireReason(input.reason);
    const userId = input.userId.trim();
    const strategyId = input.strategyId.trim();
    const id = idFor(`quant-live-halt:${requestId}`);
    return this.deps.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${LOCK}))`;
      const [done] = await tx<HaltRow[]>`SELECT * FROM trade.quant_live_halts WHERE id = ${id}`;
      if (done) {
        if (done.user_id === userId && done.strategy_id === strategyId && done.reason === reason) return haltView(done);
        throw new TradeOpsError('quant_halt_request_conflict', 'This request id was already used for another halt.');
      }
      const [run] = await tx<Array<{ run_id: string }>>`
        SELECT run_id FROM trade.quant_live_runs WHERE user_id = ${userId} AND strategy_id = ${strategyId} LIMIT 1`;
      if (!run)
        throw new TradeOpsError('quant_halt_strategy_not_found', 'No live run of this strategy exists, so there is nothing to halt.');
      const [standing] = await tx<HaltRow[]>`
        SELECT * FROM trade.quant_live_halts WHERE user_id = ${userId} AND strategy_id = ${strategyId} AND restored_at IS NULL`;
      if (standing) throw new TradeOpsError('quant_halt_already_halted', 'This strategy is already halted.');
      const now = this.deps.now();
      const [row] = await tx<HaltRow[]>`
        INSERT INTO trade.quant_live_halts (id, user_id, strategy_id, scope, reason, halted_by, halted_at)
        VALUES (${id}, ${userId}, ${strategyId}, 'one', ${reason}, ${principal.userId}, ${now.toISOString()})
        RETURNING *`;
      const live = await this.liveRuns(tx, userId, strategyId);
      await writeOperatorAudit(
        tx,
        {
          id: idFor(`quant-live-halt-audit:${requestId}`),
          kind: 'quant_live.halt',
          operatorId: principal.userId,
          accountId: userId,
          objectId: `strategy:${strategyId}`,
          approverId: null,
          reason,
          detail: { haltId: id, requestId, liveRuns: live },
        },
        now,
      );
      return haltView(row!);
    });
  }

  /**
   * The first founder: record the identity approval they filed for this request. Nothing changes until a second founder
   * confirms. A restore names a halt standing now; halting everything needs a live run; restoring everything a halt.
   */
  async propose(
    principal: Principal,
    input: { requestId: string; op: HaltOp; haltId: string | null; reason: string; approvalId: string },
  ): Promise<HaltRequestView> {
    requireOperatorWrite(principal);
    const requestId = uuid(input.requestId, 'requestId');
    if (input.op !== 'halt_all' && input.op !== 'restore' && input.op !== 'restore_all')
      throw new TradeOpsError('quant_halt_request_invalid', 'op must be halt_all, restore or restore_all');
    const reason = requireReason(input.reason);
    const approvalId = input.approvalId.trim();
    if (!approvalId) throw new TradeOpsError('approval_missing', 'approval is missing');
    const haltId = input.op === 'restore' ? uuid(input.haltId, 'haltId') : null;
    return this.deps.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${LOCK}))`;
      const [existing] = await tx<RequestRow[]>`SELECT * FROM trade.quant_live_halt_requests WHERE id = ${requestId}`;
      if (existing) {
        if (existing.approval_id === approvalId && existing.op === input.op && existing.halt_id === haltId && existing.reason === reason)
          return requestView(existing);
        throw new TradeOpsError('quant_halt_request_conflict', 'This request id was already used for another request.');
      }
      let target: HaltRow | null = null;
      if (input.op === 'restore') target = await this.standing(tx, haltId!);
      else await this.requireState(tx, input.op);
      const [row] = await tx<RequestRow[]>`
        INSERT INTO trade.quant_live_halt_requests
          (id, op, halt_id, user_id, strategy_id, reason, status, approval_id, proposed_by, created_at)
        VALUES (${requestId}, ${input.op}, ${haltId}, ${target?.user_id ?? null}, ${target?.strategy_id ?? null}, ${reason},
          'awaiting_second', ${approvalId}, ${principal.userId}, ${this.deps.now().toISOString()})
        RETURNING *`;
      return requestView(row!);
    });
  }

  /**
   * The second founder: consume the approval once (bound to this request; identity refuses the proposer as approver),
   * apply the change and write its audit row, in one transaction. The founder who asked cannot confirm. The same confirm
   * again answers the applied request.
   */
  async confirm(principal: Principal, input: { requestId: string; operationId: string }): Promise<HaltRequestView> {
    requireOperatorWrite(principal);
    const requestId = uuid(input.requestId, 'requestId');
    return this.deps.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${LOCK}))`;
      const row = await this.requestRow(tx, requestId, true);
      if (row.status === 'applied') {
        if (sameUser(row.confirmed_by, principal.userId)) return requestView(row);
        throw new TradeOpsError('quant_halt_request_decided', 'This request was already confirmed.');
      }
      if (sameUser(row.proposed_by, principal.userId))
        throw new TradeOpsError('approval_mismatch', 'The founder who asked cannot confirm. A second founder must.');
      if (row.op === 'restore') await this.standing(tx, row.halt_id!);
      else await this.requireState(tx, row.op);
      const { approverId } = await consumeApproval(this.deps.approvals, {
        approvalId: row.approval_id,
        actionType: actionTypeOf(row.op),
        targetId: row.id,
        expectedVersion: expectedVersionOf(row.op, row.halt_id),
        payloadHash: payloadHash(haltApprovalPayload({ requestId: row.id, op: row.op, haltId: row.halt_id, reason: row.reason })),
        operationId: input.operationId,
      });
      if (sameUser(row.proposed_by, approverId))
        throw new TradeOpsError('approval_mismatch', 'The founder who asked also approved it. A second founder must approve.');
      const now = this.deps.now();
      let runs = 0;
      let strategies = 0;
      if (row.op === 'halt_all') {
        // Every strategy with a live run now; one already halted keeps its own halt and its runs are counted halted.
        const targets = await tx<Array<{ user_id: string; strategy_id: string; already: boolean }>>`
          SELECT DISTINCT r.user_id, r.strategy_id, (h.id IS NOT NULL) AS already
            FROM trade.quant_live_runs r
            LEFT JOIN trade.quant_live_halts h
              ON h.user_id = r.user_id AND h.strategy_id = r.strategy_id AND h.restored_at IS NULL
           WHERE r.state IN ('signing', 'running', 'unknown')`;
        for (const t of targets) {
          if (t.already) continue;
          await tx`
            INSERT INTO trade.quant_live_halts
              (id, user_id, strategy_id, scope, reason, halted_by, halt_approver, halt_request_id, halted_at)
            VALUES (${idFor(`quant-live-halt-all:${row.id}:${t.user_id}:${t.strategy_id}`)}, ${t.user_id}, ${t.strategy_id}, 'all',
              ${row.reason}, ${row.proposed_by}, ${approverId}, ${row.id}, ${now.toISOString()})`;
          strategies += 1;
        }
        const [n] = await tx<Array<{ n: number }>>`
          SELECT count(*)::int AS n FROM trade.quant_live_runs WHERE state IN ('signing', 'running', 'unknown')`;
        runs = n?.n ?? 0;
      } else {
        const lifted = await tx<HaltRow[]>`
          UPDATE trade.quant_live_halts
             SET restore_request_id = ${row.id}, restored_by = ${row.proposed_by}, restore_approver = ${approverId},
                 restored_at = ${now.toISOString()}
           WHERE restored_at IS NULL ${row.op === 'restore' ? tx`AND id = ${row.halt_id}` : tx``}
          RETURNING *`;
        if (lifted.length === 0) throw new TradeOpsError('quant_halt_not_halted', 'Nothing is halted, so there is nothing to restore.');
        strategies = lifted.length;
        for (const h of lifted) runs += await this.liveRuns(tx, h.user_id, h.strategy_id);
      }
      const [next] = await tx<RequestRow[]>`
        UPDATE trade.quant_live_halt_requests
           SET status = 'applied', approver_id = ${approverId}, confirmed_by = ${principal.userId}, decided_at = ${now.toISOString()},
               applied_runs = ${runs}, applied_strategies = ${strategies}
         WHERE id = ${row.id} RETURNING *`;
      await writeOperatorAudit(
        tx,
        {
          id: idFor(`quant-live-${row.op}-audit:${row.id}`),
          kind: `quant_live.${row.op}`,
          operatorId: row.proposed_by,
          accountId: row.user_id,
          objectId: row.op === 'restore' ? `strategy:${row.strategy_id}` : 'strategy:*',
          approverId,
          reason: row.reason,
          detail: { requestId: row.id, confirmedBy: principal.userId, approvalId: row.approval_id, runs, strategies, haltId: row.halt_id },
        },
        now,
      );
      return requestView(next!);
    });
  }

  private async liveRuns(tx: Sql | TransactionSql, userId: string, strategyId: string): Promise<number> {
    const [n] = await tx<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM trade.quant_live_runs
       WHERE user_id = ${userId} AND strategy_id = ${strategyId} AND state IN ('signing', 'running', 'unknown')`;
    return n?.n ?? 0;
  }

  private async standing(tx: Sql | TransactionSql, haltId: string): Promise<HaltRow> {
    const [row] = await tx<HaltRow[]>`SELECT * FROM trade.quant_live_halts WHERE id = ${haltId} AND restored_at IS NULL`;
    if (!row) throw new TradeOpsError('quant_halt_not_halted', 'This halt is not standing, so there is nothing to restore.');
    return row;
  }

  private async requireState(tx: Sql | TransactionSql, op: 'halt_all' | 'restore_all'): Promise<void> {
    if (op === 'halt_all') {
      const [live] = await tx<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM trade.quant_live_runs WHERE state IN ('signing', 'running', 'unknown')`;
      if (!live?.n) throw new TradeOpsError('quant_halt_nothing_live', 'No strategy runs live now, so there is nothing to halt.');
      return;
    }
    const [halted] = await tx<Array<{ n: number }>>`SELECT count(*)::int AS n FROM trade.quant_live_halts WHERE restored_at IS NULL`;
    if (!halted?.n) throw new TradeOpsError('quant_halt_not_halted', 'Nothing is halted, so there is nothing to restore.');
  }

  private async requestRow(tx: Sql | TransactionSql, requestId: string, lock: boolean): Promise<RequestRow> {
    const [row] = lock
      ? await tx<RequestRow[]>`SELECT * FROM trade.quant_live_halt_requests WHERE id = ${requestId} FOR UPDATE`
      : await tx<RequestRow[]>`SELECT * FROM trade.quant_live_halt_requests WHERE id = ${requestId}`;
    if (!row) throw new TradeOpsError('quant_halt_request_not_found', 'No such request.');
    return row;
  }
}
