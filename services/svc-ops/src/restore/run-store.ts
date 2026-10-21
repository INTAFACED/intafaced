import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import type { RestoreStep } from '@intafaced/contracts';
import { OPS_IDEMPOTENCY_CONFLICT, OpsError } from '../codes.js';
import { OPS_LIST_LIMIT_CAP } from '../list-limit.js';

export interface RestoreRun {
  readonly restoreNo: string;
  readonly cutOff: string;
  readonly startedBy: string;
  readonly startedAt: string;
}

export interface RestoreStepRow {
  readonly restoreNo: string;
  readonly step: RestoreStep;
  readonly actor: string;
  readonly approverId: string | null;
  readonly detail: Record<string, unknown>;
  readonly at: string;
}

export type RestoreEventName = 'coreOpsRestoreStarted' | 'coreOpsRestoreCompleted' | 'coreOpsRestoreFailed';

export interface RestoreOutboxEntry {
  readonly event: RestoreEventName;
  /** Business key, for example `ops:restore:started:<restoreNo>`. */
  readonly idempotencyKey: string;
  readonly payload: Record<string, unknown>;
  readonly createdAt: string;
}

/** Digest of the request body: a reused key with another body is told apart without storing the body twice. */
export function runFingerprint(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

const conflict = () => new OpsError(OPS_IDEMPOTENCY_CONFLICT, 'This idempotency key was already used for a different request');

export interface RestoreRunStore {
  /** Stores the run under the key, or returns the run the same key stored first. A different body under the key conflicts. */
  start(key: string, fingerprint: string, run: RestoreRun, event: RestoreOutboxEntry): Promise<RestoreRun>;
  get(restoreNo: string): Promise<RestoreRun | null>;
  list(): Promise<readonly RestoreRun[]>;
  steps(restoreNo: string): Promise<readonly RestoreStepRow[]>;
  /**
   * Appends the step row and its event together. The same key and body returns the stored row; a key reused with another
   * body conflicts; a second row for the same run and step is never written, the first is returned.
   */
  appendStep(key: string, fingerprint: string, row: RestoreStepRow, event: RestoreOutboxEntry | null): Promise<RestoreStepRow>;
  /** A failure is an event and no step row; it commits alone under its business key. */
  recordFailure(event: RestoreOutboxEntry): Promise<void>;
}

/** For tests that need a store without PostgreSQL. A running service uses the durable store. */
export function createMemoryRestoreRunStore(): RestoreRunStore & { outbox(): readonly RestoreOutboxEntry[] } {
  const runs = new Map<string, { fingerprint: string; run: RestoreRun }>();
  const byNo = new Map<string, RestoreRun>();
  const steps = new Map<string, { key: string; fingerprint: string; row: RestoreStepRow }>();
  const stepKeys = new Map<string, { fingerprint: string; row: RestoreStepRow }>();
  const outbox = new Map<string, RestoreOutboxEntry>();
  return {
    outbox: () => [...outbox.values()],
    async start(key, fingerprint, run, event) {
      const hit = runs.get(key);
      if (hit) {
        if (hit.fingerprint !== fingerprint) throw conflict();
        return hit.run;
      }
      if (byNo.has(run.restoreNo)) throw conflict();
      runs.set(key, { fingerprint, run });
      byNo.set(run.restoreNo, run);
      outbox.set(event.idempotencyKey, event);
      return run;
    },
    async get(restoreNo) {
      return byNo.get(restoreNo) ?? null;
    },
    async list() {
      return [...byNo.values()].reverse();
    },
    async steps(restoreNo) {
      return [...steps.values()].filter((s) => s.row.restoreNo === restoreNo).map((s) => s.row);
    },
    async appendStep(key, fingerprint, row, event) {
      const same = stepKeys.get(key);
      if (same) {
        if (same.fingerprint !== fingerprint) throw conflict();
        return same.row;
      }
      const slot = `${row.restoreNo}:${row.step}`;
      const first = steps.get(slot);
      if (first) return first.row;
      steps.set(slot, { key, fingerprint, row });
      stepKeys.set(key, { fingerprint, row });
      if (event) outbox.set(event.idempotencyKey, event);
      return row;
    },
    async recordFailure(event) {
      if (!outbox.has(event.idempotencyKey)) outbox.set(event.idempotencyKey, event);
    },
  };
}

interface RunRow {
  restore_no: string;
  cut_off: Date;
  started_by: string;
  started_at: Date;
  fingerprint?: string;
}
interface StepRow {
  restore_no: string;
  step: RestoreStep;
  actor: string;
  approver_id: string | null;
  detail: Record<string, unknown>;
  at: Date;
  fingerprint?: string;
}

const toRun = (r: RunRow): RestoreRun => ({
  restoreNo: r.restore_no,
  cutOff: r.cut_off.toISOString(),
  startedBy: r.started_by,
  startedAt: r.started_at.toISOString(),
});
const toStep = (r: StepRow): RestoreStepRow => ({
  restoreNo: r.restore_no,
  step: r.step,
  actor: r.actor,
  approverId: r.approver_id,
  detail: r.detail,
  at: r.at.toISOString(),
});

/** Runs and steps live in `ops.restore_runs` and `ops.restore_steps` (append-only), with `ops.restore_outbox` beside them. */
export function createPgRestoreRunStore(sql: Sql): RestoreRunStore {
  const queue = (tx: Sql, e: RestoreOutboxEntry) => tx`INSERT INTO ops.restore_outbox (event,idempotency_key,payload,created_at)
    VALUES (${e.event},${e.idempotencyKey},${tx.json(e.payload as never)},${e.createdAt}) ON CONFLICT (idempotency_key) DO NOTHING`;
  return {
    async start(key, fingerprint, run, event) {
      return sql.begin(async (tx) => {
        const [existing] = await tx<RunRow[]>`SELECT restore_no,cut_off,started_by,started_at,fingerprint
          FROM ops.restore_runs WHERE idempotency_key=${key}`;
        if (existing) {
          if (existing.fingerprint !== fingerprint) throw conflict();
          return toRun(existing);
        }
        const [row] = await tx<RunRow[]>`INSERT INTO ops.restore_runs (restore_no,idempotency_key,fingerprint,cut_off,started_by,started_at)
          VALUES (${run.restoreNo},${key},${fingerprint},${run.cutOff},${run.startedBy},${run.startedAt})
          ON CONFLICT (restore_no) DO NOTHING RETURNING restore_no,cut_off,started_by,started_at`;
        if (!row) throw conflict();
        await queue(tx as unknown as Sql, event);
        return toRun(row);
      });
    },
    async get(restoreNo) {
      const [row] = await sql<
        RunRow[]
      >`SELECT restore_no,cut_off,started_by,started_at FROM ops.restore_runs WHERE restore_no=${restoreNo}`;
      return row ? toRun(row) : null;
    },
    async list() {
      const rows = await sql<RunRow[]>`SELECT restore_no,cut_off,started_by,started_at FROM ops.restore_runs
        ORDER BY started_at DESC, restore_no DESC LIMIT ${OPS_LIST_LIMIT_CAP}`;
      return rows.map(toRun);
    },
    async steps(restoreNo) {
      const rows = await sql<StepRow[]>`SELECT restore_no,step,actor,approver_id,detail,at FROM ops.restore_steps
        WHERE restore_no=${restoreNo} ORDER BY at, step`;
      return rows.map(toStep);
    },
    async appendStep(key, fingerprint, row, event) {
      return sql.begin(async (tx) => {
        const [byKey] = await tx<StepRow[]>`SELECT restore_no,step,actor,approver_id,detail,at,fingerprint
          FROM ops.restore_steps WHERE idempotency_key=${key}`;
        if (byKey) {
          if (byKey.fingerprint !== fingerprint) throw conflict();
          return toStep(byKey);
        }
        const [inserted] = await tx<
          StepRow[]
        >`INSERT INTO ops.restore_steps (restore_no,step,idempotency_key,fingerprint,actor,approver_id,detail,at)
          VALUES (${row.restoreNo},${row.step},${key},${fingerprint},${row.actor},${row.approverId},${tx.json(row.detail as never)},${row.at})
          ON CONFLICT (restore_no,step) DO NOTHING RETURNING restore_no,step,actor,approver_id,detail,at`;
        if (!inserted) {
          const [first] = await tx<StepRow[]>`SELECT restore_no,step,actor,approver_id,detail,at FROM ops.restore_steps
            WHERE restore_no=${row.restoreNo} AND step=${row.step}`;
          if (!first) throw new Error('ops.restore_step_vanished');
          return toStep(first);
        }
        if (event) await queue(tx as unknown as Sql, event);
        return toStep(inserted);
      });
    },
    async recordFailure(event) {
      await queue(sql, event);
    },
  };
}
