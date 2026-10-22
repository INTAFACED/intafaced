/**
 * OPS-alerts-03 durable desk: heartbeats, message templates and the quality policy.
 * A write stores the actor and the reason in the same transaction as the row. Templates are not sent.
 */
import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import type { RuleFields } from './rules.js';
import {
  OPS_ALERT_ACTOR_UNSET,
  OPS_ALERT_QUALITY_ENFORCED,
  OPS_ALERT_QUALITY_REQUIREMENT_INVALID,
  OPS_ALERT_QUALITY_VERSION_STALE,
  OPS_ALERT_TEMPLATE_BODY_UNSET,
  OPS_ALERT_TEMPLATE_VERSION_STALE,
  OPS_IDEMPOTENCY_CONFLICT,
  OpsError,
} from '../codes.js';

export const ALERT_ANNOTATION_KEYS = ['summary', 'runbookUrl', 'dashboardUid', 'panelId'] as const;
export type AlertAnnotationKey = (typeof ALERT_ANNOTATION_KEYS)[number];

const LABEL_KEY = /^[a-z][a-z0-9_]{0,62}$/;

export interface QualityRequirement {
  readonly kind: 'annotation' | 'label';
  readonly key: string;
  readonly mode: 'detect' | 'enforce';
}

export interface HeartbeatRow {
  readonly actor: string;
  readonly reason: string;
  readonly recordedAt: string;
}

export interface TemplateRow {
  readonly name: string;
  readonly body: string;
  readonly version: number;
  readonly actor: string;
  readonly reason: string;
  readonly updatedAt: string;
}

export interface QualityPolicy {
  readonly version: number;
  readonly requirements: QualityRequirement[];
  readonly actor: string;
  readonly reason: string;
  readonly updatedAt: string;
}

export interface AlertDeskStore {
  recordHeartbeat(input: {
    readonly key: string;
    readonly fingerprint: string;
    readonly actor: string;
    readonly reason: string;
    readonly at: string;
  }): Promise<HeartbeatRow>;
  latestHeartbeat(): Promise<HeartbeatRow | null>;
  saveTemplate(input: {
    readonly name: string;
    readonly body: string;
    readonly expectedVersion?: number;
    readonly key: string;
    readonly fingerprint: string;
    readonly actor: string;
    readonly reason: string;
    readonly at: string;
  }): Promise<TemplateRow>;
  getTemplate(name: string): Promise<TemplateRow | null>;
  listTemplates(limit: number): Promise<readonly TemplateRow[]>;
  getPolicy(): Promise<QualityPolicy | null>;
  savePolicy(input: {
    readonly requirements: readonly QualityRequirement[];
    readonly expectedVersion?: number;
    readonly key: string;
    readonly fingerprint: string;
    readonly actor: string;
    readonly reason: string;
    readonly at: string;
  }): Promise<QualityPolicy>;
  assertWritable(fields: RuleFields): Promise<void>;
}

export function fingerprintOf(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

export function assertActor(actor: string): string {
  const trimmed = actor.trim();
  if (!trimmed) throw new OpsError(OPS_ALERT_ACTOR_UNSET, 'The operator id is blank. Nothing was saved.');
  return trimmed;
}

export function parseRequirements(raw: readonly QualityRequirement[]): QualityRequirement[] {
  if (raw.length > 20) {
    throw new OpsError(OPS_ALERT_QUALITY_REQUIREMENT_INVALID, 'A quality policy has at most 20 requirements.');
  }
  const seen = new Set<string>();
  return raw.map((req) => {
    if (req.mode !== 'detect' && req.mode !== 'enforce') {
      throw new OpsError(OPS_ALERT_QUALITY_REQUIREMENT_INVALID, 'A requirement is detect or enforce. Nothing was saved.');
    }
    if (req.kind === 'annotation') {
      if (!ALERT_ANNOTATION_KEYS.includes(req.key as AlertAnnotationKey)) {
        throw new OpsError(
          OPS_ALERT_QUALITY_REQUIREMENT_INVALID,
          `"${req.key}" is not an annotation this service stores. Nothing was saved.`,
        );
      }
    } else if (req.kind === 'label') {
      if (!LABEL_KEY.test(req.key)) {
        throw new OpsError(OPS_ALERT_QUALITY_REQUIREMENT_INVALID, `"${req.key}" is not a label name. Nothing was saved.`);
      }
    } else {
      throw new OpsError(OPS_ALERT_QUALITY_REQUIREMENT_INVALID, 'A requirement is an annotation or a label. Nothing was saved.');
    }
    const id = `${req.kind}:${req.key}`;
    if (seen.has(id)) throw new OpsError(OPS_ALERT_QUALITY_REQUIREMENT_INVALID, `${id} is listed twice. Nothing was saved.`);
    seen.add(id);
    return { kind: req.kind, key: req.key, mode: req.mode };
  });
}

/** Which required fields a rule does not carry. Empty or whitespace counts as missing. The check does not judge the contents. */
export function missingRequirements(
  fields: Pick<RuleFields, 'labels' | 'annotations'>,
  requirements: readonly QualityRequirement[],
): readonly QualityRequirement[] {
  return requirements.filter((req) => {
    if (req.kind === 'label') {
      const value = fields.labels[req.key];
      return value === undefined || value.trim() === '';
    }
    const value = fields.annotations[req.key as AlertAnnotationKey];
    return typeof value !== 'string' || value.trim() === '';
  });
}

function enforcedMessage(missing: readonly QualityRequirement[]): string {
  const names = missing.map((req) => `${req.kind}:${req.key}`).join(', ');
  return `Enforced quality requirements are missing (${names}). The rule was not saved.`;
}

interface HeartbeatHit extends HeartbeatRow {
  readonly key: string;
  readonly fingerprint: string;
}

interface TemplateHit {
  readonly key: string;
  readonly fingerprint: string;
  readonly row: TemplateRow;
}

export function createMemoryAlertDesk(): AlertDeskStore {
  const beats: HeartbeatHit[] = [];
  const templates = new Map<string, TemplateRow>();
  const templateKeys: TemplateHit[] = [];
  let policy: QualityPolicy | null = null;
  const policyKeys: { key: string; fingerprint: string; row: QualityPolicy }[] = [];

  return {
    async recordHeartbeat(input) {
      const actor = assertActor(input.actor);
      const prior = beats.find((row) => row.key === input.key);
      if (prior) {
        if (prior.fingerprint !== input.fingerprint) {
          throw new OpsError(OPS_IDEMPOTENCY_CONFLICT, 'This idempotency key was already used for a different heartbeat.');
        }
        return { actor: prior.actor, reason: prior.reason, recordedAt: prior.recordedAt };
      }
      const row = { actor, reason: input.reason, recordedAt: input.at };
      beats.push({ ...row, key: input.key, fingerprint: input.fingerprint });
      return row;
    },
    async latestHeartbeat() {
      const last = beats[beats.length - 1];
      return last ? { actor: last.actor, reason: last.reason, recordedAt: last.recordedAt } : null;
    },
    async saveTemplate(input) {
      const actor = assertActor(input.actor);
      const body = input.body.trim();
      if (!body) throw new OpsError(OPS_ALERT_TEMPLATE_BODY_UNSET, 'The template body is blank. Nothing was saved.');
      const prior = templateKeys.find((row) => row.key === input.key);
      if (prior) {
        if (prior.fingerprint !== input.fingerprint) {
          throw new OpsError(OPS_IDEMPOTENCY_CONFLICT, 'This idempotency key was already used for a different template.');
        }
        return prior.row;
      }
      const current = templates.get(input.name) ?? null;
      if (current?.version !== input.expectedVersion && !(current === null && input.expectedVersion === undefined)) {
        throw new OpsError(
          OPS_ALERT_TEMPLATE_VERSION_STALE,
          current
            ? `The template is at version ${current.version}, not ${input.expectedVersion ?? 'a new template'}.`
            : 'No such template to update.',
        );
      }
      const row: TemplateRow = {
        name: input.name,
        body,
        version: (current?.version ?? 0) + 1,
        actor,
        reason: input.reason,
        updatedAt: input.at,
      };
      templates.set(input.name, row);
      templateKeys.push({ key: input.key, fingerprint: input.fingerprint, row });
      return row;
    },
    async getTemplate(name) {
      return templates.get(name) ?? null;
    },
    async listTemplates(limit) {
      return [...templates.values()].sort((a, b) => (a.name < b.name ? -1 : 1)).slice(0, limit);
    },
    async getPolicy() {
      return policy;
    },
    async savePolicy(input) {
      const actor = assertActor(input.actor);
      const requirements = parseRequirements(input.requirements);
      const prior = policyKeys.find((row) => row.key === input.key);
      if (prior) {
        if (prior.fingerprint !== input.fingerprint) {
          throw new OpsError(OPS_IDEMPOTENCY_CONFLICT, 'This idempotency key was already used for a different quality policy.');
        }
        return prior.row;
      }
      if (policy?.version !== input.expectedVersion && !(policy === null && input.expectedVersion === undefined)) {
        throw new OpsError(
          OPS_ALERT_QUALITY_VERSION_STALE,
          policy
            ? `The quality policy is at version ${policy.version}, not ${input.expectedVersion ?? 'a new policy'}.`
            : 'No quality policy to update.',
        );
      }
      const row: QualityPolicy = {
        version: (policy?.version ?? 0) + 1,
        requirements,
        actor,
        reason: input.reason,
        updatedAt: input.at,
      };
      policy = row;
      policyKeys.push({ key: input.key, fingerprint: input.fingerprint, row });
      return row;
    },
    async assertWritable(fields) {
      if (!policy || policy.requirements.length === 0) return;
      const missing = missingRequirements(fields, policy.requirements).filter((req) => req.mode === 'enforce');
      if (missing.length > 0) throw new OpsError(OPS_ALERT_QUALITY_ENFORCED, enforcedMessage(missing));
    },
  };
}

const iso = (d: Date) => d.toISOString();

export function createPgAlertDesk(sql: Sql): AlertDeskStore {
  return {
    async recordHeartbeat(input) {
      const actor = assertActor(input.actor);
      return sql.begin(async (tx) => {
        const [prior] = await tx<{ actor: string; reason: string; recorded_at: Date; fingerprint: string }[]>`
          SELECT actor, reason, recorded_at, fingerprint FROM ops.alert_heartbeats WHERE idempotency_key = ${input.key}`;
        if (prior) {
          if (prior.fingerprint !== input.fingerprint) {
            throw new OpsError(OPS_IDEMPOTENCY_CONFLICT, 'This idempotency key was already used for a different heartbeat.');
          }
          return { actor: prior.actor, reason: prior.reason, recordedAt: iso(prior.recorded_at) };
        }
        const [row] = await tx<{ actor: string; reason: string; recorded_at: Date }[]>`
          INSERT INTO ops.alert_heartbeats (idempotency_key, fingerprint, actor, reason, recorded_at)
          VALUES (${input.key}, ${input.fingerprint}, ${actor}, ${input.reason}, ${input.at})
          RETURNING actor, reason, recorded_at`;
        return { actor: row!.actor, reason: row!.reason, recordedAt: iso(row!.recorded_at) };
      });
    },
    async latestHeartbeat() {
      const [row] = await sql<{ actor: string; reason: string; recorded_at: Date }[]>`
        SELECT actor, reason, recorded_at FROM ops.alert_heartbeats ORDER BY id DESC LIMIT 1`;
      return row ? { actor: row.actor, reason: row.reason, recordedAt: iso(row.recorded_at) } : null;
    },
    async saveTemplate(input) {
      const actor = assertActor(input.actor);
      const body = input.body.trim();
      if (!body) throw new OpsError(OPS_ALERT_TEMPLATE_BODY_UNSET, 'The template body is blank. Nothing was saved.');
      return sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext(${`ops.alert.template:${input.name}`}))`;
        const [prior] = await tx<
          { fingerprint: string; body: string; version: number; actor: string; reason: string; at: Date; name: string }[]
        >`
          SELECT name, body, version, actor, reason, at, fingerprint FROM ops.alert_template_versions WHERE idempotency_key = ${input.key}`;
        if (prior) {
          if (prior.fingerprint !== input.fingerprint) {
            throw new OpsError(OPS_IDEMPOTENCY_CONFLICT, 'This idempotency key was already used for a different template.');
          }
          return {
            name: prior.name,
            body: prior.body,
            version: prior.version,
            actor: prior.actor,
            reason: prior.reason,
            updatedAt: iso(prior.at),
          };
        }
        const [current] = await tx<{ version: number }[]>`SELECT version FROM ops.alert_templates WHERE name = ${input.name}`;
        const currentVersion = current?.version;
        if (currentVersion !== input.expectedVersion && !(currentVersion === undefined && input.expectedVersion === undefined)) {
          throw new OpsError(
            OPS_ALERT_TEMPLATE_VERSION_STALE,
            currentVersion !== undefined
              ? `The template is at version ${currentVersion}, not ${input.expectedVersion ?? 'a new template'}.`
              : 'No such template to update.',
          );
        }
        const version = (currentVersion ?? 0) + 1;
        if (!current) {
          await tx`INSERT INTO ops.alert_templates (name, body, version, actor, reason, updated_at)
            VALUES (${input.name}, ${body}, ${version}, ${actor}, ${input.reason}, ${input.at})`;
        } else {
          await tx`UPDATE ops.alert_templates SET body = ${body}, version = ${version}, actor = ${actor}, reason = ${input.reason}, updated_at = ${input.at}
            WHERE name = ${input.name}`;
        }
        await tx`INSERT INTO ops.alert_template_versions (name, version, body, actor, reason, idempotency_key, fingerprint, at)
          VALUES (${input.name}, ${version}, ${body}, ${actor}, ${input.reason}, ${input.key}, ${input.fingerprint}, ${input.at})`;
        return { name: input.name, body, version, actor, reason: input.reason, updatedAt: input.at };
      });
    },
    async getTemplate(name) {
      const [row] = await sql<{ name: string; body: string; version: number; actor: string; reason: string; updated_at: Date }[]>`
        SELECT name, body, version, actor, reason, updated_at FROM ops.alert_templates WHERE name = ${name}`;
      return row
        ? { name: row.name, body: row.body, version: row.version, actor: row.actor, reason: row.reason, updatedAt: iso(row.updated_at) }
        : null;
    },
    async listTemplates(limit) {
      const rows = await sql<{ name: string; body: string; version: number; actor: string; reason: string; updated_at: Date }[]>`
        SELECT name, body, version, actor, reason, updated_at FROM ops.alert_templates ORDER BY name LIMIT ${limit}`;
      return rows.map((row) => ({
        name: row.name,
        body: row.body,
        version: row.version,
        actor: row.actor,
        reason: row.reason,
        updatedAt: iso(row.updated_at),
      }));
    },
    async getPolicy() {
      const [row] = await sql<{ requirements: QualityRequirement[]; version: number; actor: string; reason: string; updated_at: Date }[]>`
        SELECT requirements, version, actor, reason, updated_at FROM ops.alert_quality_policy WHERE id = 1`;
      return row
        ? { version: row.version, requirements: row.requirements, actor: row.actor, reason: row.reason, updatedAt: iso(row.updated_at) }
        : null;
    },
    async savePolicy(input) {
      const actor = assertActor(input.actor);
      const requirements = parseRequirements(input.requirements);
      return sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext('ops.alert.quality'))`;
        const [prior] = await tx<
          { fingerprint: string; requirements: QualityRequirement[]; version: number; actor: string; reason: string; at: Date }[]
        >`
          SELECT requirements, version, actor, reason, at, fingerprint FROM ops.alert_quality_policy_versions WHERE idempotency_key = ${input.key}`;
        if (prior) {
          if (prior.fingerprint !== input.fingerprint) {
            throw new OpsError(OPS_IDEMPOTENCY_CONFLICT, 'This idempotency key was already used for a different quality policy.');
          }
          return {
            version: prior.version,
            requirements: prior.requirements,
            actor: prior.actor,
            reason: prior.reason,
            updatedAt: iso(prior.at),
          };
        }
        const [current] = await tx<{ version: number }[]>`SELECT version FROM ops.alert_quality_policy WHERE id = 1`;
        const currentVersion = current?.version;
        if (currentVersion !== input.expectedVersion && !(currentVersion === undefined && input.expectedVersion === undefined)) {
          throw new OpsError(
            OPS_ALERT_QUALITY_VERSION_STALE,
            currentVersion !== undefined
              ? `The quality policy is at version ${currentVersion}, not ${input.expectedVersion ?? 'a new policy'}.`
              : 'No quality policy to update.',
          );
        }
        const version = (currentVersion ?? 0) + 1;
        await tx`INSERT INTO ops.alert_quality_policy_versions (version, requirements, actor, reason, idempotency_key, fingerprint, at)
          VALUES (${version}, ${tx.json(requirements as never)}, ${actor}, ${input.reason}, ${input.key}, ${input.fingerprint}, ${input.at})`;
        if (!current) {
          await tx`INSERT INTO ops.alert_quality_policy (id, requirements, version, actor, reason, updated_at)
            VALUES (1, ${tx.json(requirements as never)}, ${version}, ${actor}, ${input.reason}, ${input.at})`;
        } else {
          await tx`UPDATE ops.alert_quality_policy
            SET requirements = ${tx.json(requirements as never)}, version = ${version}, actor = ${actor}, reason = ${input.reason}, updated_at = ${input.at}
            WHERE id = 1`;
        }
        return { version, requirements, actor, reason: input.reason, updatedAt: input.at };
      });
    },
    async assertWritable(fields) {
      const policy = await this.getPolicy();
      if (!policy || policy.requirements.length === 0) return;
      const missing = missingRequirements(fields, policy.requirements).filter((req) => req.mode === 'enforce');
      if (missing.length > 0) throw new OpsError(OPS_ALERT_QUALITY_ENFORCED, enforcedMessage(missing));
    },
  };
}
