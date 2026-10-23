import type { Sql } from 'postgres';
import type { OpsAlertHealth, OpsAlertState } from '@intafaced/contracts';
import { opsAlertBusinessKey } from '@intafaced/contracts';
import type { InstanceState, StepResult } from './evaluate.js';

export type AlertEventName = 'coreOpsAlertRuleUpdated' | 'coreOpsAlertOpened' | 'coreOpsAlertResolved' | 'coreOpsAlertPolicyUpdated';

export interface OutboxRow {
  readonly id: number;
  readonly event: AlertEventName;
  readonly idempotencyKey: string;
  readonly payload: Record<string, unknown>;
  readonly attempts: number;
}

export interface OutboxEntry {
  readonly event: AlertEventName;
  readonly idempotencyKey: string;
  readonly payload: Record<string, unknown>;
  readonly createdAt: string;
}

export interface HistoryRow {
  readonly id: number;
  readonly ruleId: string;
  readonly instance: string;
  readonly epoch: number;
  readonly at: string;
  readonly from: OpsAlertState;
  readonly to: OpsAlertState;
  readonly health: OpsAlertHealth;
  readonly value: string | null;
  readonly code: string | null;
}

export interface HistoryFilter {
  readonly ruleId?: string;
  readonly state?: OpsAlertState;
  readonly since?: string;
  readonly until?: string;
  /** Newest first; one more than this is read to tell whether the page was cut. */
  readonly limit: number;
}

/** One stored instance that is pending or firing. Normal is not an active alert. */
export interface ActiveInstance {
  readonly ruleId: string;
  readonly instance: string;
  readonly state: OpsAlertState;
  readonly health: OpsAlertHealth;
  readonly epoch: number;
  readonly pendingSince: string | null;
  readonly firingSince: string | null;
  readonly lastEvaluatedAt: string;
  readonly lastValue: string | null;
  readonly lastCode: string | null;
}

export interface AlertStateStore {
  /**
   * Runs one evaluation under a per-instance lock, so two replicas cannot both evaluate or both announce. `run` sees the stored state;
   * returning null means "not due" and writes nothing. The state, its history row and its outbox events commit together.
   */
  evaluate(ruleId: string, instance: string, run: (prev: InstanceState | null) => StepResult | null): Promise<StepResult | null>;
  /** The stored state of each rule's instance, by rule id. A rule never evaluated has none. */
  states(ruleIds: readonly string[]): Promise<ReadonlyMap<string, InstanceState & { readonly instance: string }>>;
  history(filter: HistoryFilter): Promise<{ readonly rows: readonly HistoryRow[]; readonly truncated: boolean }>;
  /** Pending and firing instances only, firing first. `limit` and `offset` are the caller's; this does not invent a page size. */
  active(states: readonly ('pending' | 'firing')[], limit: number, offset?: number): Promise<readonly ActiveInstance[]>;
}

export interface AlertOutbox {
  pending(limit: number): Promise<readonly OutboxRow[]>;
  markPublished(id: number, at: string): Promise<void>;
  markFailed(id: number, error: string): Promise<void>;
}

/** The events one evaluation announces, keyed so a repeat is the same event. */
export function transitionEntries(ruleId: string, instance: string, result: StepResult): readonly OutboxEntry[] {
  return result.transitions.map((t): OutboxEntry =>
    t.kind === 'opened'
      ? {
          event: 'coreOpsAlertOpened',
          idempotencyKey: opsAlertBusinessKey('opened', ruleId, instance, t.epoch),
          payload: { ruleId, instance, epoch: t.epoch, state: t.state, openedAt: t.at },
          createdAt: t.at,
        }
      : {
          event: 'coreOpsAlertResolved',
          idempotencyKey: opsAlertBusinessKey('resolved', ruleId, instance, t.epoch),
          payload: { ruleId, instance, epoch: t.epoch, resolvedAt: t.at },
          createdAt: t.at,
        },
  );
}

/** For tests that need the state store and its outbox without PostgreSQL. */
export function createMemoryAlertState(): AlertStateStore &
  AlertOutbox & { readonly enqueue: (entry: OutboxEntry) => void; readonly rows: () => readonly (OutboxRow & { published: boolean })[] } {
  const instances = new Map<string, InstanceState & { instance: string; ruleId: string }>();
  const history: HistoryRow[] = [];
  type Mutable = { -readonly [K in keyof OutboxRow]: OutboxRow[K] } & { published: boolean; failure?: string };
  const outbox: Mutable[] = [];
  const enqueue = (entry: OutboxEntry): void => {
    if (outbox.some((o) => o.idempotencyKey === entry.idempotencyKey)) return;
    outbox.push({
      id: outbox.length + 1,
      event: entry.event,
      idempotencyKey: entry.idempotencyKey,
      payload: entry.payload,
      attempts: 0,
      published: false,
    });
  };
  return {
    enqueue,
    rows: () => outbox,
    async evaluate(ruleId, instance, run) {
      const key = `${ruleId}:${instance}`;
      const prev = instances.get(key) ?? null;
      const result = run(prev);
      if (!result) return null;
      instances.set(key, { ...result.next, instance, ruleId });
      if (result.changed) {
        history.push({
          id: history.length + 1,
          ruleId,
          instance,
          epoch: result.next.epoch,
          at: result.next.lastEvaluatedAt,
          from: prev?.state ?? 'normal',
          to: result.next.state,
          health: result.next.health,
          value: result.next.lastValue,
          code: result.next.lastCode,
        });
      }
      for (const entry of transitionEntries(ruleId, instance, result)) enqueue(entry);
      return result;
    },
    async states(ruleIds) {
      const out = new Map<string, InstanceState & { instance: string }>();
      for (const id of ruleIds) for (const [k, v] of instances) if (k.startsWith(`${id}:`)) out.set(id, v);
      return out;
    },
    async history(f) {
      const rows = history
        .filter(
          (h) =>
            (f.ruleId === undefined || h.ruleId === f.ruleId) &&
            (f.state === undefined || h.to === f.state) &&
            (f.since === undefined || h.at >= f.since) &&
            (f.until === undefined || h.at <= f.until),
        )
        .sort((a, b) => b.id - a.id);
      return { rows: rows.slice(0, f.limit), truncated: rows.length > f.limit };
    },
    async active(states, limit, offset = 0) {
      if (limit < 1 || offset < 0) return [];
      const wanted = new Set<string>(states);
      return [...instances.values()]
        .filter((row) => wanted.has(row.state))
        .sort((a, b) => {
          const rank = (state: string) => (state === 'firing' ? 0 : 1);
          const byState = rank(a.state) - rank(b.state);
          if (byState !== 0) return byState;
          const when = (row: { firingSince: string | null; pendingSince: string | null }) => row.firingSince ?? row.pendingSince ?? '';
          const byWhen = when(b).localeCompare(when(a));
          if (byWhen !== 0) return byWhen;
          const byRule = a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0;
          if (byRule !== 0) return byRule;
          return a.instance < b.instance ? -1 : a.instance > b.instance ? 1 : 0;
        })
        .slice(offset, offset + limit)
        .map((row) => ({
          ruleId: row.ruleId,
          instance: row.instance,
          state: row.state,
          health: row.health,
          epoch: row.epoch,
          pendingSince: row.pendingSince,
          firingSince: row.firingSince,
          lastEvaluatedAt: row.lastEvaluatedAt,
          lastValue: row.lastValue,
          lastCode: row.lastCode,
        }));
    },
    async pending(limit) {
      return outbox.filter((o) => !o.published).slice(0, limit);
    },
    async markPublished(id) {
      const row = outbox.find((o) => o.id === id);
      if (row) row.published = true;
    },
    async markFailed(id, error) {
      const row = outbox.find((o) => o.id === id);
      if (row) {
        row.attempts += 1;
        row.failure = error;
      }
    },
  };
}

interface InstanceRow {
  rule_id: string;
  instance: string;
  state: OpsAlertState;
  health: OpsAlertHealth;
  epoch: number;
  pending_since: Date | null;
  firing_since: Date | null;
  last_evaluated_at: Date;
  last_value: string | null;
  last_code: string | null;
  kept: boolean;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

const toInstance = (r: InstanceRow): InstanceState & { instance: string } => ({
  instance: r.instance,
  state: r.state,
  health: r.health,
  epoch: r.epoch,
  pendingSince: iso(r.pending_since),
  firingSince: iso(r.firing_since),
  lastEvaluatedAt: r.last_evaluated_at.toISOString(),
  lastValue: r.last_value,
  lastCode: r.last_code,
  kept: r.kept,
});

export function createPgAlertState(sql: Sql): AlertStateStore & AlertOutbox {
  return {
    async evaluate(ruleId, instance, run) {
      return sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext(${`ops.alert:${ruleId}:${instance}`}))`;
        const [row] = await tx<InstanceRow[]>`SELECT * FROM ops.alert_instances WHERE rule_id=${ruleId} AND instance=${instance}`;
        const prev = row ? toInstance(row) : null;
        const result = run(prev);
        if (!result) return null;
        const n = result.next;
        await tx`INSERT INTO ops.alert_instances (rule_id,instance,state,health,epoch,pending_since,firing_since,last_evaluated_at,last_value,last_code,kept)
          VALUES (${ruleId},${instance},${n.state},${n.health},${n.epoch},${n.pendingSince},${n.firingSince},${n.lastEvaluatedAt},${n.lastValue},${n.lastCode},${n.kept})
          ON CONFLICT (rule_id,instance) DO UPDATE SET state=EXCLUDED.state,health=EXCLUDED.health,epoch=EXCLUDED.epoch,
            pending_since=EXCLUDED.pending_since,firing_since=EXCLUDED.firing_since,last_evaluated_at=EXCLUDED.last_evaluated_at,
            last_value=EXCLUDED.last_value,last_code=EXCLUDED.last_code,kept=EXCLUDED.kept`;
        if (result.changed) {
          await tx`INSERT INTO ops.alert_state_history (rule_id,instance,epoch,at,from_state,to_state,health,value,code)
            VALUES (${ruleId},${instance},${n.epoch},${n.lastEvaluatedAt},${prev?.state ?? 'normal'},${n.state},${n.health},${n.lastValue},${n.lastCode})`;
        }
        for (const entry of transitionEntries(ruleId, instance, result)) {
          await tx`INSERT INTO ops.alert_outbox (event,idempotency_key,payload,created_at)
            VALUES (${entry.event},${entry.idempotencyKey},${tx.json(entry.payload as never)},${entry.createdAt})
            ON CONFLICT (idempotency_key) DO NOTHING`;
        }
        return result;
      });
    },
    async states(ruleIds) {
      if (ruleIds.length === 0) return new Map();
      const rows = await sql<InstanceRow[]>`SELECT * FROM ops.alert_instances WHERE rule_id IN ${sql(ruleIds)}`;
      return new Map(rows.map((r) => [r.rule_id, toInstance(r)]));
    },
    async history(f) {
      const rows = await sql<
        {
          id: string;
          rule_id: string;
          instance: string;
          epoch: number;
          at: Date;
          from_state: OpsAlertState;
          to_state: OpsAlertState;
          health: OpsAlertHealth;
          value: string | null;
          code: string | null;
        }[]
      >`SELECT * FROM ops.alert_state_history
        WHERE (${f.ruleId ?? null}::uuid IS NULL OR rule_id=${f.ruleId ?? null})
          AND (${f.state ?? null}::text IS NULL OR to_state=${f.state ?? null})
          AND (${f.since ?? null}::timestamptz IS NULL OR at >= ${f.since ?? null})
          AND (${f.until ?? null}::timestamptz IS NULL OR at <= ${f.until ?? null})
        ORDER BY id DESC LIMIT ${f.limit + 1}`;
      return {
        rows: rows.slice(0, f.limit).map((r) => ({
          id: Number(r.id),
          ruleId: r.rule_id,
          instance: r.instance,
          epoch: r.epoch,
          at: r.at.toISOString(),
          from: r.from_state,
          to: r.to_state,
          health: r.health,
          value: r.value,
          code: r.code,
        })),
        truncated: rows.length > f.limit,
      };
    },
    async active(states, limit, offset = 0) {
      if (states.length === 0 || limit < 1 || offset < 0) return [];
      const rows = await sql<InstanceRow[]>`SELECT * FROM ops.alert_instances
        WHERE state IN ${sql([...states])}
        ORDER BY CASE state WHEN 'firing' THEN 0 ELSE 1 END,
          COALESCE(firing_since, pending_since) DESC NULLS LAST,
          rule_id, instance
        LIMIT ${limit} OFFSET ${offset}`;
      return rows.map((r) => {
        const inst = toInstance(r);
        return {
          ruleId: r.rule_id,
          instance: inst.instance,
          state: inst.state,
          health: inst.health,
          epoch: inst.epoch,
          pendingSince: inst.pendingSince,
          firingSince: inst.firingSince,
          lastEvaluatedAt: inst.lastEvaluatedAt,
          lastValue: inst.lastValue,
          lastCode: inst.lastCode,
        };
      });
    },
    async pending(limit) {
      const rows = await sql<
        { id: string; event: AlertEventName; idempotency_key: string; payload: Record<string, unknown>; attempts: number }[]
      >`
        SELECT id,event,idempotency_key,payload,attempts FROM ops.alert_outbox WHERE published_at IS NULL ORDER BY id LIMIT ${limit}`;
      return rows.map((r) => ({
        id: Number(r.id),
        event: r.event,
        idempotencyKey: r.idempotency_key,
        payload: r.payload,
        attempts: r.attempts,
      }));
    },
    async markPublished(id, at) {
      await sql`UPDATE ops.alert_outbox SET published_at=${at} WHERE id=${id}`;
    },
    async markFailed(id, error) {
      await sql`UPDATE ops.alert_outbox SET attempts=attempts+1,last_error=${error.slice(0, 500)} WHERE id=${id}`;
    },
  };
}
