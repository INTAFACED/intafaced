import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import { CustodyApprovalError, CustodyTaskExecutionError } from './errors.js';
import type {
  ApproverRole,
  ApproverView,
  ConfigProposeInput,
  ConfigScope,
  InitiateInput,
  ListInput,
  PendingInput,
  QuorumView,
  RegisterApproverInput,
  SetQuorumInput,
  SettleResult,
  TaskDetail,
  TaskKind,
  TaskStatus,
  TaskView,
} from './schemas.js';

/**
 * Custody approval tasks, admin quorum and the approver registry (W-custody-ops-06). NO BALANCE LIVES HERE: a task moves
 * nothing by itself; when its approvals are in, a registered EXECUTOR runs the frozen payload under the idempotency key
 * `custody-task:<taskId>`, so a crash between the last approval and the run resumes with the same key and nothing runs twice.
 *
 * - A task is `custody_transaction` (the gate for W-custody-ops-09) or `config` (a workspace configuration change: address
 *   whitelists, connections, users, policy, approval groups). Each has an owner-set quorum and expiry; none refuses
 *   `quorum_unset`. With no executor (or, for config, no applier for that scope) a task is refused at submit with
 *   `executor_unwired`, so nothing waits for something that cannot run.
 * - The PAYLOAD is hashed (`payloadHashOf`) and every decision names that hash: a changed payload is a new task.
 * - APPROVERS are registered by a founder and are `founder` or `keyless` (decide, hold no key). Only an active registered
 *   approver counts. The initiator never decides their own task, and one approver counts once.
 * - ONE REJECTION ends a task. A task past its deadline is `expired` and never runs; an approved task never expires.
 * - The executor throws `CustodyTaskExecutionError`: `retryable` leaves the task `approved` so `settleDue` or the next call
 *   runs the same task again; anything else ends it `failed` with the code.
 */

export interface TaskExecution {
  readonly taskId: string;
  /** `custody-task:<taskId>`: the business key an executor passes on to everything it posts or sends. */
  readonly idempotencyKey: string;
  readonly kind: TaskKind;
  readonly scope: ConfigScope | null;
  readonly payload: Record<string, unknown>;
  readonly payloadHash: string;
  readonly initiator: string;
}
export type TaskExecutor = (task: TaskExecution) => Promise<void>;

export interface CustodyApprovalDeps {
  readonly sql: Sql;
  /** Runs an approved `custody_transaction` task. Absent: such a task is refused at submit. */
  readonly transactionExecutor?: TaskExecutor;
  /** Applies an approved configuration change, per scope. A scope with no applier is refused at submit. */
  readonly configAppliers?: Partial<Record<ConfigScope, TaskExecutor>>;
  readonly now?: () => Date;
}

interface TaskRow {
  id: string;
  client_ref: string;
  kind: TaskKind;
  scope: ConfigScope | null;
  title: string;
  payload: Record<string, unknown>;
  payload_hash: string;
  initiator: string;
  required_approvals: number;
  status: TaskStatus;
  failure_code: string | null;
  expires_at: Date;
  created_at: Date;
  decided_at: Date | null;
  executed_at: Date | null;
}
interface QuorumRow {
  kind: TaskKind;
  required_approvals: number;
  expiry_seconds: number;
  set_by: string;
  set_at: Date;
}
interface ApproverRow {
  user_id: string;
  label: string;
  role: ApproverRole;
  active: boolean;
  set_by: string;
  set_at: Date;
}

const COLUMNS = `id, client_ref, kind, scope, title, payload, payload_hash, initiator, required_approvals, status, failure_code,
  expires_at, created_at, decided_at, executed_at`;

const stable = (value: unknown): string =>
  JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as object).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );

/** A digest of exactly what the task would run. A changed payload, kind or scope is a different hash and so a new task. */
export function payloadHashOf(kind: TaskKind, scope: ConfigScope | null, payload: Record<string, unknown>): string {
  return createHash('sha256')
    .update(stable([kind, scope, payload]))
    .digest('hex');
}

export class CustodyApprovalService {
  private readonly now: () => Date;
  constructor(private readonly deps: CustodyApprovalDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  // ── owner settings ────────────────────────────────────────────────────────

  async setQuorum(actor: string, input: SetQuorumInput): Promise<QuorumView> {
    const [row] = await this.deps.sql<QuorumRow[]>`
      INSERT INTO pay.custody_task_quorum_events (kind, required_approvals, expiry_seconds, set_by)
      VALUES (${input.kind}, ${input.requiredApprovals}, ${input.expirySeconds}, ${actor})
      RETURNING kind, required_approvals, expiry_seconds, set_by, set_at`;
    return quorumView(row!);
  }

  async quorum(kind: TaskKind): Promise<QuorumView | null> {
    const row = await this.latestQuorum(this.deps.sql, kind);
    return row ? quorumView(row) : null;
  }

  // ── approvers ─────────────────────────────────────────────────────────────

  async registerApprover(actor: string, input: RegisterApproverInput): Promise<ApproverView> {
    const [row] = await this.deps.sql<ApproverRow[]>`
      INSERT INTO pay.custody_approver_events (user_id, label, role, active, set_by)
      VALUES (${input.userId}, ${input.label}, ${input.role}, true, ${actor})
      RETURNING user_id, label, role, active, set_by, set_at`;
    return approverView(row!);
  }

  async revokeApprover(actor: string, userId: string): Promise<ApproverView> {
    const current = await this.latestApprover(this.deps.sql, userId);
    if (!current) throw new CustodyApprovalError('custody_approval.approver_unknown', 'no such approver');
    if (!current.active) return approverView(current);
    const [row] = await this.deps.sql<ApproverRow[]>`
      INSERT INTO pay.custody_approver_events (user_id, label, role, active, set_by)
      VALUES (${userId}, ${current.label}, ${current.role}, false, ${actor})
      RETURNING user_id, label, role, active, set_by, set_at`;
    return approverView(row!);
  }

  async listApprovers(): Promise<ApproverView[]> {
    const rows = await this.deps.sql<ApproverRow[]>`
      SELECT DISTINCT ON (user_id) user_id, label, role, active, set_by, set_at
        FROM pay.custody_approver_events ORDER BY user_id, seq DESC`;
    return rows.map(approverView);
  }

  // ── submit ────────────────────────────────────────────────────────────────

  /** Start a custody transaction task. Needs the transaction executor (W-custody-ops-09) wired. */
  async initiate(initiator: string, input: InitiateInput): Promise<TaskView> {
    if (!this.deps.transactionExecutor) {
      throw new CustodyApprovalError(
        'custody_approval.executor_unwired',
        'nothing runs an approved custody transaction yet (W-custody-ops-09), so none can be requested',
      );
    }
    return this.submit(initiator, 'custody_transaction', null, input);
  }

  /** Propose a workspace configuration change. Needs an applier for the scope. */
  async proposeConfig(initiator: string, input: ConfigProposeInput): Promise<TaskView> {
    if (!this.deps.configAppliers?.[input.scope]) {
      throw new CustodyApprovalError('custody_approval.executor_unwired', `nothing applies an approved ${input.scope} change yet`, {
        scope: input.scope,
      });
    }
    return this.submit(initiator, 'config', input.scope, input);
  }

  // ── decide ────────────────────────────────────────────────────────────────

  async approve(approverId: string, taskId: string, payloadHash: string, kind?: TaskKind): Promise<TaskView> {
    const task = await this.load(taskId);
    this.assertKind(task, kind);
    await this.assertMayDecide(approverId, task, payloadHash);
    const outcome = await transaction(this.deps.sql, async (tx) => {
      const row = await this.lock(tx, taskId);
      if (row.status === 'approved' || row.status === 'executed') return { row, expired: false };
      if (row.status !== 'pending') {
        throw new CustodyApprovalError('custody_approval.not_pending', `this task is ${row.status}`, { status: row.status });
      }
      const now = this.now();
      if (row.expires_at <= now) {
        await this.close(tx, row, 'expired', 'system');
        return { row, expired: true };
      }
      const added = await tx`
        INSERT INTO pay.custody_task_decisions (task_id, approver_id, decision, payload_hash, decided_at)
        VALUES (${taskId}, ${approverId}, 'approve', ${payloadHash}, ${now}) ON CONFLICT DO NOTHING RETURNING task_id`;
      if (added.length > 0) await this.event(tx, taskId, 'approved', approverId, {});
      const [count] = await tx<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM pay.custody_task_decisions WHERE task_id = ${taskId} AND decision = 'approve'`;
      if (count!.n < row.required_approvals) return { row, expired: false };
      const [done] = await tx<TaskRow[]>`
        UPDATE pay.custody_tasks SET status = 'approved', decided_at = ${now}, updated_at = ${now}
         WHERE id = ${taskId} AND status = 'pending' RETURNING ${tx.unsafe(COLUMNS)}`;
      await this.event(tx, taskId, 'quorum', approverId, { approvals: count!.n });
      return { row: done!, expired: false };
    });
    if (outcome.expired) throw new CustodyApprovalError('custody_approval.expired', 'this task passed its deadline and did not run');
    if (outcome.row.status === 'approved') await this.execute(outcome.row);
    return this.view(approverId, (await this.byId(this.deps.sql, taskId))!);
  }

  /** Any registered approver may refuse, and one refusal ends the task. */
  async reject(approverId: string, taskId: string, payloadHash: string, kind?: TaskKind): Promise<TaskView> {
    const task = await this.load(taskId);
    this.assertKind(task, kind);
    await this.assertMayDecide(approverId, task, payloadHash);
    await transaction(this.deps.sql, async (tx) => {
      const row = await this.lock(tx, taskId);
      if (row.status === 'rejected') return;
      if (row.status !== 'pending') {
        throw new CustodyApprovalError('custody_approval.not_pending', `this task is ${row.status}`, { status: row.status });
      }
      await tx`
        INSERT INTO pay.custody_task_decisions (task_id, approver_id, decision, payload_hash, decided_at)
        VALUES (${taskId}, ${approverId}, 'reject', ${payloadHash}, ${this.now()}) ON CONFLICT DO NOTHING`;
      await this.close(tx, row, 'rejected', approverId);
    });
    return this.view(approverId, (await this.byId(this.deps.sql, taskId))!);
  }

  /** The initiator withdraws their own task while it waits. */
  async cancel(actor: string, taskId: string): Promise<TaskView> {
    const task = await this.load(taskId);
    if (task.initiator !== actor) throw notFound();
    await transaction(this.deps.sql, async (tx) => {
      const row = await this.lock(tx, taskId);
      if (row.status === 'canceled') return;
      if (row.status !== 'pending') {
        throw new CustodyApprovalError('custody_approval.not_pending', `this task is ${row.status}`, { status: row.status });
      }
      await this.close(tx, row, 'canceled', actor);
    });
    return this.view(actor, (await this.byId(this.deps.sql, taskId))!);
  }

  // ── reads ─────────────────────────────────────────────────────────────────

  async get(viewerId: string, taskId: string): Promise<TaskDetail> {
    const row = await this.byId(this.deps.sql, taskId);
    if (!row) throw notFound();
    const timeline = await this.deps.sql<Array<{ kind: string; actor_id: string; detail: Record<string, unknown>; at: Date }>>`
      SELECT kind, actor_id, detail, at FROM pay.custody_task_events WHERE task_id = ${taskId} ORDER BY seq`;
    return {
      ...(await this.view(viewerId, row)),
      timeline: timeline.map((e) => ({ kind: e.kind, actor: e.actor_id, detail: e.detail, at: e.at.toISOString() })),
    };
  }

  async list(viewerId: string, input: ListInput): Promise<TaskView[]> {
    const limit = this.limit(input.limit);
    const rows = await this.deps.sql<TaskRow[]>`
      SELECT ${this.deps.sql.unsafe(COLUMNS)} FROM pay.custody_tasks
       WHERE (${input.status ?? null}::text IS NULL OR status = ${input.status ?? null})
         AND (${input.kind ?? null}::text IS NULL OR kind = ${input.kind ?? null})
         AND (${input.after ?? null}::uuid IS NULL
              OR (created_at, id) < (SELECT created_at, id FROM pay.custody_tasks WHERE id = ${input.after ?? null}::uuid))
       ORDER BY created_at DESC, id DESC LIMIT ${limit}`;
    return Promise.all(rows.map((r) => this.view(viewerId, r)));
  }

  /** Waiting tasks this approver may still decide: they are an active registered approver, not the initiator, and have not decided. */
  async pending(approverId: string, input: PendingInput): Promise<TaskView[]> {
    const limit = this.limit(input.limit);
    const approver = await this.latestApprover(this.deps.sql, approverId);
    if (!approver?.active) {
      throw new CustodyApprovalError('custody_approval.approver_not_registered', 'this person is not an active registered approver');
    }
    const rows = await this.deps.sql<TaskRow[]>`
      SELECT ${this.deps.sql.unsafe(COLUMNS)} FROM pay.custody_tasks t
       WHERE t.status = 'pending' AND t.expires_at > ${this.now()} AND t.initiator <> ${approverId}
         AND NOT EXISTS (SELECT 1 FROM pay.custody_task_decisions d WHERE d.task_id = t.id AND d.approver_id = ${approverId})
         AND (${input.after ?? null}::uuid IS NULL
              OR (t.created_at, t.id) < (SELECT created_at, id FROM pay.custody_tasks WHERE id = ${input.after ?? null}::uuid))
       ORDER BY t.created_at DESC, t.id DESC LIMIT ${limit}`;
    return Promise.all(rows.map((r) => this.view(approverId, r)));
  }

  // ── sweep ─────────────────────────────────────────────────────────────────

  /** One pass of the due work, safe to repeat: expire pending tasks past their deadline, and run any approved task that was never run. */
  async settleDue(actor: string): Promise<SettleResult> {
    const result: SettleResult = { expired: 0, executed: 0, failures: [] };
    const due = await this.deps.sql<Array<{ id: string }>>`
      SELECT id FROM pay.custody_tasks WHERE status = 'pending' AND expires_at <= ${this.now()} ORDER BY expires_at LIMIT 200`;
    for (const { id } of due) {
      try {
        const expired = await transaction(this.deps.sql, async (tx) => {
          const row = await this.lock(tx, id);
          if (row.status !== 'pending' || row.expires_at > this.now()) return false;
          await this.close(tx, row, 'expired', actor);
          return true;
        });
        if (expired) result.expired += 1;
      } catch (error) {
        result.failures.push({ taskId: id, code: codeOf(error) });
      }
    }
    const approved = await this.deps.sql<TaskRow[]>`
      SELECT ${this.deps.sql.unsafe(COLUMNS)} FROM pay.custody_tasks WHERE status = 'approved' ORDER BY decided_at LIMIT 200`;
    for (const row of approved) {
      try {
        if (await this.execute(row)) result.executed += 1;
      } catch (error) {
        result.failures.push({ taskId: row.id, code: codeOf(error) });
      }
    }
    return result;
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private async submit(
    initiator: string,
    kind: TaskKind,
    scope: ConfigScope | null,
    input: { title: string; payload: Record<string, unknown>; clientRef: string },
  ): Promise<TaskView> {
    const hash = payloadHashOf(kind, scope, input.payload);
    const existing = await this.byRef(this.deps.sql, input.clientRef);
    if (existing) return this.sameAsExisting(initiator, existing, hash, initiator);
    const quorum = await this.latestQuorum(this.deps.sql, kind);
    if (!quorum) throw new CustodyApprovalError('custody_approval.quorum_unset', `no approval quorum is set for ${kind} tasks`);
    const now = this.now();
    const inserted = await transaction(this.deps.sql, async (tx) => {
      const rows = await tx<TaskRow[]>`
        INSERT INTO pay.custody_tasks
          (client_ref, kind, scope, title, payload, payload_hash, initiator, required_approvals, expires_at, created_at, updated_at)
        VALUES (${input.clientRef}, ${kind}, ${scope}, ${input.title}, ${tx.json(input.payload as never)}, ${hash}, ${initiator},
                ${quorum.required_approvals}, ${new Date(now.getTime() + quorum.expiry_seconds * 1000)}, ${now}, ${now})
        ON CONFLICT (client_ref) DO NOTHING
        RETURNING ${tx.unsafe(COLUMNS)}`;
      if (rows[0]) await this.event(tx, rows[0].id, 'initiated', initiator, { kind, scope });
      return rows[0] ?? null;
    });
    const row = inserted ?? (await this.byRef(this.deps.sql, input.clientRef));
    if (!row) throw notFound();
    return this.sameAsExisting(initiator, row, hash, initiator);
  }

  private sameAsExisting(viewer: string, row: TaskRow, hash: string, initiator: string): Promise<TaskView> {
    if (row.payload_hash !== hash || row.initiator !== initiator) {
      throw new CustodyApprovalError('custody_approval.conflict', `client reference "${row.client_ref}" already names a different task`, {
        taskId: row.id,
      });
    }
    return this.view(viewer, row);
  }

  /** Run the frozen payload. Returns true when it ran to the end. A retryable outcome leaves the task `approved` and rethrows. */
  private async execute(task: TaskRow): Promise<boolean> {
    const run = task.kind === 'config' ? this.deps.configAppliers?.[task.scope as ConfigScope] : this.deps.transactionExecutor;
    if (!run) return false; // the executor was unplugged after submit: the task stays approved until one is wired
    try {
      await run({
        taskId: task.id,
        idempotencyKey: `custody-task:${task.id}`,
        kind: task.kind,
        scope: task.scope,
        payload: task.payload,
        payloadHash: task.payload_hash,
        initiator: task.initiator,
      });
    } catch (error) {
      if (error instanceof CustodyTaskExecutionError && !error.retryable) {
        await this.finish(task.id, 'failed', error.code);
        throw error;
      }
      throw error; // unknown outcome: the task stays approved and the same key runs again
    }
    await this.finish(task.id, 'executed', null);
    return true;
  }

  private async finish(id: string, to: 'executed' | 'failed', failureCode: string | null): Promise<void> {
    const now = this.now();
    await transaction(this.deps.sql, async (tx) => {
      const moved = await tx`
        UPDATE pay.custody_tasks
           SET status = ${to}, failure_code = ${failureCode}, executed_at = ${to === 'executed' ? now : null}, updated_at = ${now}
         WHERE id = ${id} AND status = 'approved' RETURNING id`;
      if (moved.length > 0) await this.event(tx, id, to, 'system', failureCode ? { code: failureCode } : {});
    });
  }

  private async close(tx: Sql, row: TaskRow, to: 'rejected' | 'canceled' | 'expired', actor: string): Promise<void> {
    const now = this.now();
    await tx`UPDATE pay.custody_tasks SET status = ${to}, decided_at = ${now}, updated_at = ${now} WHERE id = ${row.id}`;
    await this.event(tx, row.id, to, actor, {});
  }

  private assertKind(task: TaskRow, kind: TaskKind | undefined): void {
    if (kind && task.kind !== kind) throw new CustodyApprovalError('custody_approval.wrong_kind', `this is a ${task.kind} task`);
  }

  private async assertMayDecide(approverId: string, task: TaskRow, payloadHash: string): Promise<void> {
    if (approverId === task.initiator) {
      throw new CustodyApprovalError('custody_approval.initiator_cannot_decide', 'the person who started a task cannot decide it');
    }
    if (payloadHash !== task.payload_hash) {
      throw new CustodyApprovalError('custody_approval.hash_mismatch', 'the task is not the one that was read; read it again');
    }
    const approver = await this.latestApprover(this.deps.sql, approverId);
    if (!approver?.active) {
      throw new CustodyApprovalError('custody_approval.approver_not_registered', 'this person is not an active registered approver');
    }
  }

  private limit(limit: number | undefined): number {
    if (limit === undefined) throw new CustodyApprovalError('custody_approval.list_limit_unset', 'pass a page size; there is no default');
    return limit;
  }

  private async latestQuorum(q: Sql, kind: TaskKind): Promise<QuorumRow | null> {
    const [row] = await q<QuorumRow[]>`
      SELECT kind, required_approvals, expiry_seconds, set_by, set_at
        FROM pay.custody_task_quorum_events WHERE kind = ${kind} ORDER BY seq DESC LIMIT 1`;
    return row ?? null;
  }

  private async latestApprover(q: Sql, userId: string): Promise<ApproverRow | null> {
    const [row] = await q<ApproverRow[]>`
      SELECT user_id, label, role, active, set_by, set_at
        FROM pay.custody_approver_events WHERE user_id = ${userId} ORDER BY seq DESC LIMIT 1`;
    return row ?? null;
  }

  private async load(taskId: string): Promise<TaskRow> {
    const row = await this.byId(this.deps.sql, taskId);
    if (!row) throw notFound();
    return row;
  }

  private async byId(q: Sql, id: string): Promise<TaskRow | null> {
    const [row] = await q<TaskRow[]>`SELECT ${q.unsafe(COLUMNS)} FROM pay.custody_tasks WHERE id = ${id}`;
    return row ?? null;
  }

  private async byRef(q: Sql, clientRef: string): Promise<TaskRow | null> {
    const [row] = await q<TaskRow[]>`SELECT ${q.unsafe(COLUMNS)} FROM pay.custody_tasks WHERE client_ref = ${clientRef}`;
    return row ?? null;
  }

  private async lock(tx: Sql, id: string): Promise<TaskRow> {
    const [row] = await tx<TaskRow[]>`SELECT ${tx.unsafe(COLUMNS)} FROM pay.custody_tasks WHERE id = ${id} FOR UPDATE`;
    if (!row) throw notFound();
    return row;
  }

  private async event(q: Sql, taskId: string, kind: string, actor: string, detail: Record<string, unknown>): Promise<void> {
    await q`
      INSERT INTO pay.custody_task_events (task_id, kind, actor_id, detail)
      VALUES (${taskId}, ${kind}, ${actor}, ${q.json(detail as never)})`;
  }

  private async view(viewerId: string, r: TaskRow): Promise<TaskView> {
    const [counts] = await this.deps.sql<Array<{ n: number; mine: boolean }>>`
      SELECT count(*) FILTER (WHERE decision = 'approve')::int AS n,
             COALESCE(bool_or(approver_id = ${viewerId} AND decision = 'approve'), false) AS mine
        FROM pay.custody_task_decisions WHERE task_id = ${r.id}`;
    return {
      id: r.id,
      clientRef: r.client_ref,
      kind: r.kind,
      scope: r.scope,
      title: r.title,
      payload: r.payload,
      payloadHash: r.payload_hash,
      initiator: r.initiator,
      requiredApprovals: r.required_approvals,
      approvalCount: counts?.n ?? 0,
      approvedByMe: counts?.mine ?? false,
      status: r.status,
      failureCode: r.failure_code,
      expiresAt: r.expires_at.toISOString(),
      createdAt: r.created_at.toISOString(),
      decidedAt: r.decided_at ? r.decided_at.toISOString() : null,
      executedAt: r.executed_at ? r.executed_at.toISOString() : null,
    };
  }
}

const notFound = () => new CustodyApprovalError('custody_approval.not_found', 'no such task');
const codeOf = (error: unknown): string =>
  error instanceof CustodyApprovalError || error instanceof CustodyTaskExecutionError ? error.code : 'unexpected';

function quorumView(r: QuorumRow): QuorumView {
  return {
    kind: r.kind,
    requiredApprovals: r.required_approvals,
    expirySeconds: r.expiry_seconds,
    setBy: r.set_by,
    setAt: r.set_at.toISOString(),
  };
}
function approverView(r: ApproverRow): ApproverView {
  return { userId: r.user_id, label: r.label, role: r.role, active: r.active, setBy: r.set_by, setAt: r.set_at.toISOString() };
}
