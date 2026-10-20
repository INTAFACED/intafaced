import type { Sql } from 'postgres';
import type { OpsAlertRule } from '@intafaced/contracts';
import { OPS_ALERT_LABELS_DUPLICATE, OPS_ALERT_RULE_NOT_FOUND, OPS_IDEMPOTENCY_CONFLICT, OpsError } from '../codes.js';
import type { OutboxEntry } from './state-store.js';
import { labelsHash, type AlertRuleStore, type ApplyCommand, type ListFilter, type RuleState, type RuleVersion } from './rules.js';

const conflict = () => new OpsError(OPS_IDEMPOTENCY_CONFLICT, 'This idempotency key was already used for a different request');
const notFound = () => new OpsError(OPS_ALERT_RULE_NOT_FOUND, 'No such alert rule.');
const duplicate = () =>
  new OpsError(
    OPS_ALERT_LABELS_DUPLICATE,
    'Another live rule already has exactly this label set. Change a label or retire the other rule.',
  );

function build(cmd: ApplyCommand, current: OpsAlertRule | null, next: RuleState): OpsAlertRule {
  return {
    id: current?.id ?? cmd.newId,
    name: next.name,
    folder: next.folder,
    group: next.group,
    signal: next.signal,
    condition: next.condition,
    intervalSeconds: next.intervalSeconds,
    pendingSeconds: next.pendingSeconds,
    labels: next.labels,
    annotations: next.annotations,
    noData: next.noData,
    execError: next.execError,
    paused: next.paused,
    version: (current?.version ?? 0) + 1,
    createdAt: current?.createdAt ?? cmd.at,
    updatedAt: cmd.at,
    retiredAt: next.retired ? (current?.retiredAt ?? cmd.at) : null,
  };
}

/** The event a saved version announces. Its key is the rule and the version, so a retry is the same event. */
function ruleEvent(rule: OpsAlertRule, cmd: ApplyCommand): OutboxEntry {
  return {
    event: 'coreOpsAlertRuleUpdated',
    idempotencyKey: `ops:alert_rule:${rule.id}:${rule.version}`,
    payload: { ruleId: rule.id, version: rule.version, change: cmd.change, actor: cmd.actor, changedAt: cmd.at },
    createdAt: cmd.at,
  };
}

const matches = (rule: OpsAlertRule, f: ListFilter): boolean =>
  (f.includeRetired || rule.retiredAt === null) &&
  (f.folder === undefined || rule.folder === f.folder) &&
  (f.group === undefined || rule.group === f.group) &&
  (f.nameContains === undefined || rule.name.toLowerCase().includes(f.nameContains.toLowerCase())) &&
  (f.label === undefined || rule.labels[f.label.key] === f.label.value);

const order = (a: OpsAlertRule, b: OpsAlertRule): number =>
  a.folder.localeCompare(b.folder, 'en') ||
  a.group.localeCompare(b.group, 'en') ||
  a.name.localeCompare(b.name, 'en') ||
  a.id.localeCompare(b.id, 'en');

/** For tests that need a store without PostgreSQL. A running service uses the durable store. */
export function createMemoryAlertRuleStore(outbox?: { enqueue(entry: OutboxEntry): void }): AlertRuleStore {
  const rules = new Map<string, OpsAlertRule>();
  const versions: (RuleVersion & { key: string; fingerprint: string })[] = [];
  return {
    async apply(cmd) {
      const prior = versions.find((v) => v.key === cmd.key);
      if (prior) {
        if (prior.fingerprint !== cmd.fingerprint) throw conflict();
        return prior.rule;
      }
      const current = cmd.ruleId ? (rules.get(cmd.ruleId) ?? null) : null;
      if (cmd.ruleId && !current) throw notFound();
      const next = cmd.compute(current);
      const rule = build(cmd, current, next);
      const hash = labelsHash(rule.labels);
      if (rule.retiredAt === null && hash !== null) {
        for (const other of rules.values()) {
          if (other.id !== rule.id && other.retiredAt === null && labelsHash(other.labels) === hash) throw duplicate();
        }
      }
      rules.set(rule.id, rule);
      outbox?.enqueue(ruleEvent(rule, cmd));
      versions.push({
        version: rule.version,
        change: cmd.change,
        actor: cmd.actor,
        reason: cmd.reason,
        at: cmd.at,
        rule,
        key: cmd.key,
        fingerprint: cmd.fingerprint,
      });
      return rule;
    },
    async get(id) {
      return rules.get(id) ?? null;
    },
    async list(f) {
      const after = f.after;
      return [...rules.values()]
        .filter((r) => matches(r, f))
        .sort(order)
        .filter((r) => !after || order(r, { ...r, ...after }) > 0)
        .slice(0, f.limit);
    },
    async versions(id, limit) {
      return versions
        .filter((v) => v.rule.id === id)
        .sort((a, b) => b.version - a.version)
        .slice(0, limit)
        .map(({ key: _key, fingerprint: _fingerprint, ...v }) => v);
    },
  };
}

interface RuleRow {
  id: string;
  name: string;
  folder: string;
  rule_group: string;
  signal: string;
  operator: OpsAlertRule['condition']['operator'];
  threshold: string;
  interval_seconds: number;
  pending_seconds: number;
  labels: Record<string, string>;
  annotations: OpsAlertRule['annotations'];
  no_data: OpsAlertRule['noData'];
  exec_error: OpsAlertRule['execError'];
  paused: boolean;
  version: number;
  created_at: Date;
  updated_at: Date;
  retired_at: Date | null;
}

const toRule = (r: RuleRow): OpsAlertRule => ({
  id: r.id,
  name: r.name,
  folder: r.folder,
  group: r.rule_group,
  signal: r.signal,
  condition: { operator: r.operator, threshold: r.threshold },
  intervalSeconds: r.interval_seconds,
  pendingSeconds: r.pending_seconds,
  labels: r.labels,
  annotations: r.annotations,
  noData: r.no_data,
  execError: r.exec_error,
  paused: r.paused,
  version: r.version,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
  retiredAt: r.retired_at ? r.retired_at.toISOString() : null,
});

interface PgError {
  code?: string;
  constraint_name?: string;
}

export function createPgAlertRuleStore(sql: Sql): AlertRuleStore {
  const get = async (id: string): Promise<OpsAlertRule | null> => {
    const [row] = await sql<RuleRow[]>`SELECT * FROM ops.alert_rules WHERE id=${id}`;
    return row ? toRule(row) : null;
  };
  const apply = async (cmd: ApplyCommand, retry: boolean): Promise<OpsAlertRule> => {
    try {
      return await sql.begin(async (tx) => {
        const [prior] = await tx<{ snapshot: OpsAlertRule; fingerprint: string }[]>`SELECT snapshot,fingerprint FROM ops.alert_rule_versions
          WHERE idempotency_key=${cmd.key}`;
        if (prior) {
          if (prior.fingerprint !== cmd.fingerprint) throw conflict();
          return prior.snapshot;
        }
        let current: OpsAlertRule | null = null;
        if (cmd.ruleId) {
          const [row] = await tx<RuleRow[]>`SELECT * FROM ops.alert_rules WHERE id=${cmd.ruleId} FOR UPDATE`;
          if (!row) throw notFound();
          current = toRule(row);
        }
        const next = cmd.compute(current);
        const rule = build(cmd, current, next);
        const hash = labelsHash(rule.labels);
        if (current) {
          await tx`UPDATE ops.alert_rules SET name=${rule.name},folder=${rule.folder},rule_group=${rule.group},signal=${rule.signal},
            operator=${rule.condition.operator},threshold=${rule.condition.threshold},interval_seconds=${rule.intervalSeconds},
            pending_seconds=${rule.pendingSeconds},labels=${tx.json(rule.labels)},labels_hash=${hash},annotations=${tx.json(rule.annotations)},
            no_data=${rule.noData},exec_error=${rule.execError},paused=${rule.paused},version=${rule.version},updated_at=${rule.updatedAt},
            retired_at=${rule.retiredAt} WHERE id=${rule.id}`;
        } else {
          await tx`INSERT INTO ops.alert_rules (id,name,folder,rule_group,signal,operator,threshold,interval_seconds,pending_seconds,labels,labels_hash,
            annotations,no_data,exec_error,paused,version,created_at,updated_at,retired_at)
            VALUES (${rule.id},${rule.name},${rule.folder},${rule.group},${rule.signal},${rule.condition.operator},${rule.condition.threshold},
            ${rule.intervalSeconds},${rule.pendingSeconds},${tx.json(rule.labels)},${hash},${tx.json(rule.annotations)},${rule.noData},
            ${rule.execError},${rule.paused},${rule.version},${rule.createdAt},${rule.updatedAt},${rule.retiredAt})`;
        }
        await tx`INSERT INTO ops.alert_rule_versions (rule_id,version,change,snapshot,actor,reason,idempotency_key,fingerprint,at)
          VALUES (${rule.id},${rule.version},${cmd.change},${tx.json(rule)},${cmd.actor},${cmd.reason},${cmd.key},${cmd.fingerprint},${cmd.at})`;
        const event = ruleEvent(rule, cmd);
        await tx`INSERT INTO ops.alert_outbox (event,idempotency_key,payload,created_at)
          VALUES (${event.event},${event.idempotencyKey},${tx.json(event.payload as never)},${event.createdAt})
          ON CONFLICT (idempotency_key) DO NOTHING`;
        return rule;
      });
    } catch (err) {
      const pg = err as PgError;
      if (pg.code === '23505') {
        // A racing call with the same key committed first: read its row through the same path. The label index can fire before
        // the key does (the same create sent twice), so a first collision looks up the key again; a real duplicate repeats.
        if (retry && (pg.constraint_name === 'alert_rules_labels_live_idx' || pg.constraint_name === 'alert_rule_versions_idempotency_key'))
          return apply(cmd, false);
        if (pg.constraint_name === 'alert_rules_labels_live_idx') throw duplicate();
      }
      throw err;
    }
  };
  return {
    apply: (cmd) => apply(cmd, true),
    get,
    async list(f) {
      const like = f.nameContains === undefined ? null : `%${f.nameContains.replace(/[\\%_]/g, '\\$&')}%`;
      const after = f.after;
      const rows = await sql<RuleRow[]>`SELECT * FROM ops.alert_rules
        WHERE (${f.includeRetired} OR retired_at IS NULL)
          AND (${f.folder ?? null}::text IS NULL OR folder=${f.folder ?? null})
          AND (${f.group ?? null}::text IS NULL OR rule_group=${f.group ?? null})
          AND (${like}::text IS NULL OR name ILIKE ${like} ESCAPE '\\')
          AND (${f.label ? sql.json({ [f.label.key]: f.label.value }) : null}::jsonb IS NULL OR labels @> ${f.label ? sql.json({ [f.label.key]: f.label.value }) : null}::jsonb)
          AND (${after ? after.folder : null}::text IS NULL OR (folder,rule_group,name,id::text) > (${after?.folder ?? ''},${after?.group ?? ''},${after?.name ?? ''},${after?.id ?? ''}))
        ORDER BY folder, rule_group, name, id::text LIMIT ${f.limit}`;
      return rows.map(toRule);
    },
    async versions(id, limit) {
      const rows = await sql<
        { version: number; change: RuleVersion['change']; actor: string; reason: string; at: Date; snapshot: OpsAlertRule }[]
      >`SELECT version,change,actor,reason,at,snapshot FROM ops.alert_rule_versions WHERE rule_id=${id} ORDER BY version DESC LIMIT ${limit}`;
      return rows.map((r) => ({
        version: r.version,
        change: r.change,
        actor: r.actor,
        reason: r.reason,
        at: r.at.toISOString(),
        rule: r.snapshot,
      }));
    },
  };
}
