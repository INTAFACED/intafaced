/**
 * OPS-alerts-03 durable desk: heartbeats, message templates and the quality policy.
 * A write stores the actor and the reason in the same transaction as the row. Templates are not sent.
 */
import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import type { RuleFields } from './rules.js';
import {
  OPS_ALERT_ACTOR_UNSET,
  OPS_ALERT_LABEL_REQUIRED,
  OPS_ALERT_QUALITY_REQUIREMENT_INVALID,
  OPS_ALERT_QUALITY_VERSION_STALE,
  OPS_ALERT_TEMPLATE_BODY_UNSET,
  OPS_ALERT_TEMPLATE_TITLE_UNSET,
  OPS_ALERT_TEMPLATE_VARIABLE_INVALID,
  OPS_ALERT_TEMPLATE_VERSION_STALE,
  OPS_IDEMPOTENCY_CONFLICT,
  OPS_TEMPLATE_NAME_TAKEN,
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

/** Fixed actor on a pipeline beat. Not an operator session, and not a test beat. */
export const ALERT_EVALUATOR_ACTOR = 'system:alert-evaluator';
/** Fixed reason stored with the pipeline beat. The operator does not supply it. */
export const ALERT_EVALUATOR_REASON = 'evaluator cycle completed';

/** Business key of one completed evaluator cycle. The cycle start is the clock reading when that tick began. */
export function pipelineHeartbeatKey(cycleStart: string): string {
  return `heartbeat:${cycleStart}`;
}

export interface HeartbeatRow {
  /** Pipeline beats use `heartbeat:<cycle start>`. A test beat uses the operator's idempotency key. */
  readonly key: string;
  readonly actor: string;
  readonly reason: string;
  readonly recordedAt: string;
}

export interface TemplateVariable {
  readonly name: string;
  readonly source: 'label' | 'query';
}

export interface TemplateRow {
  readonly name: string;
  readonly title: string;
  readonly body: string;
  readonly variables: TemplateVariable[];
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
  /** Pipeline beat only. `heartbeatStatus` reads these rows and nothing else. */
  recordHeartbeat(input: {
    readonly key: string;
    readonly fingerprint: string;
    readonly actor: string;
    readonly reason: string;
    readonly at: string;
  }): Promise<HeartbeatRow>;
  /** Operator test beat. Stored apart so it cannot move the pipeline clock. */
  recordTestBeat(input: {
    readonly key: string;
    readonly fingerprint: string;
    readonly actor: string;
    readonly reason: string;
    readonly at: string;
  }): Promise<HeartbeatRow>;
  latestHeartbeat(): Promise<HeartbeatRow | null>;
  saveTemplate(input: {
    readonly name: string;
    readonly title: string;
    readonly body: string;
    readonly variables: readonly TemplateVariable[];
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

function placeholder(): RegExp {
  return /\{\{(label|query):([a-z][a-z0-9_]{0,62})\}\}/g;
}

/** No `enforce` requirement is on. An unset policy is not enforcement, so a missing variable may be saved. */
export function isDetectOnly(policy: { readonly requirements: readonly QualityRequirement[] } | null): boolean {
  if (!policy) return true;
  return policy.requirements.every((req) => req.mode === 'detect');
}

export function parseTemplateVariables(raw: readonly { name: string; source: string }[]): TemplateVariable[] {
  if (raw.length > 40) {
    throw new OpsError(OPS_ALERT_TEMPLATE_VARIABLE_INVALID, 'A template declares at most 40 variables. Nothing was saved.');
  }
  const seen = new Set<string>();
  return raw.map((variable) => {
    if (variable.source !== 'label' && variable.source !== 'query') {
      throw new OpsError(OPS_ALERT_TEMPLATE_VARIABLE_INVALID, 'A template variable is a label or a query value. Nothing was saved.');
    }
    if (!LABEL_KEY.test(variable.name)) {
      throw new OpsError(OPS_ALERT_TEMPLATE_VARIABLE_INVALID, `"${variable.name}" is not a variable name. Nothing was saved.`);
    }
    const id = `${variable.source}:${variable.name}`;
    if (seen.has(id)) throw new OpsError(OPS_ALERT_TEMPLATE_VARIABLE_INVALID, `${id} is listed twice. Nothing was saved.`);
    seen.add(id);
    return { name: variable.name, source: variable.source };
  });
}

export interface TemplatePreviewData {
  readonly sample: 'TEST' | 'custom';
  readonly labels?: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, string>>;
}

/**
 * Renders title and body. A referenced variable with no usable value is left in place and named in `missing`.
 * The built-in sample sets every declared variable to the literal TEST, so the preview cannot be read as a live alert.
 */
export function previewTemplate(input: {
  readonly title: string;
  readonly body: string;
  readonly variables: readonly TemplateVariable[];
  readonly data: TemplatePreviewData;
}): { readonly title: string; readonly body: string; readonly missing: readonly string[]; readonly sample: 'TEST' | 'custom' } {
  const declared = new Set(input.variables.map((variable) => `${variable.source}:${variable.name}`));
  const labels: Record<string, string> = {};
  const query: Record<string, string> = {};
  if (input.data.sample === 'TEST') {
    for (const variable of input.variables) {
      if (variable.source === 'label') labels[variable.name] = 'TEST';
      else query[variable.name] = 'TEST';
    }
  } else {
    Object.assign(labels, input.data.labels ?? {});
    Object.assign(query, input.data.query ?? {});
  }
  const missing: string[] = [];
  const fill = (text: string): string =>
    text.replace(placeholder(), (token, source: string, name: string) => {
      const id = `${source}:${name}`;
      const value = source === 'query' ? query[name] : labels[name];
      if (!declared.has(id) || value === undefined || value.trim() === '') {
        if (!missing.includes(id)) missing.push(id);
        return token;
      }
      return value;
    });
  return { title: fill(input.title), body: fill(input.body), missing, sample: input.data.sample };
}

/** Save may keep a missing variable only while nothing is enforced. The TEST preview is the check. */
export function assertTemplateVariablesSavable(
  policy: { readonly requirements: readonly QualityRequirement[] } | null,
  title: string,
  body: string,
  variables: readonly TemplateVariable[],
): void {
  const preview = previewTemplate({ title, body, variables, data: { sample: 'TEST' } });
  if (preview.missing.length === 0 || isDetectOnly(policy)) return;
  throw new OpsError(
    OPS_ALERT_LABEL_REQUIRED,
    `The template is missing ${preview.missing.join(', ')}. Save is allowed with a missing variable only while every quality requirement is detect. Nothing was saved.`,
  );
}

function preparedTemplate(input: { readonly title: string; readonly body: string; readonly variables: readonly TemplateVariable[] }): {
  readonly title: string;
  readonly body: string;
  readonly variables: TemplateVariable[];
} {
  const title = input.title.trim();
  const body = input.body.trim();
  if (!title) throw new OpsError(OPS_ALERT_TEMPLATE_TITLE_UNSET, 'The template title is blank. Nothing was saved.');
  if (!body) throw new OpsError(OPS_ALERT_TEMPLATE_BODY_UNSET, 'The template body is blank. Nothing was saved.');
  return { title, body, variables: parseTemplateVariables(input.variables) };
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

function appendBeat(rows: HeartbeatHit[], input: Parameters<AlertDeskStore['recordHeartbeat']>[0]): HeartbeatRow {
  const actor = assertActor(input.actor);
  const prior = rows.find((row) => row.key === input.key);
  if (prior) {
    if (prior.fingerprint !== input.fingerprint) {
      throw new OpsError(OPS_IDEMPOTENCY_CONFLICT, 'This idempotency key was already used for a different heartbeat.');
    }
    return { key: prior.key, actor: prior.actor, reason: prior.reason, recordedAt: prior.recordedAt };
  }
  const row = { key: input.key, actor, reason: input.reason, recordedAt: input.at };
  rows.push({ ...row, fingerprint: input.fingerprint });
  return row;
}

export function createMemoryAlertDesk(): AlertDeskStore {
  const beats: HeartbeatHit[] = [];
  const testBeats: HeartbeatHit[] = [];
  const templates = new Map<string, TemplateRow>();
  const templateKeys: TemplateHit[] = [];
  let policy: QualityPolicy | null = null;
  const policyKeys: { key: string; fingerprint: string; row: QualityPolicy }[] = [];

  return {
    async recordHeartbeat(input) {
      return appendBeat(beats, input);
    },
    async recordTestBeat(input) {
      return appendBeat(testBeats, input);
    },
    async latestHeartbeat() {
      const last = beats[beats.length - 1];
      return last ? { key: last.key, actor: last.actor, reason: last.reason, recordedAt: last.recordedAt } : null;
    },
    async saveTemplate(input) {
      const actor = assertActor(input.actor);
      const prior = templateKeys.find((row) => row.key === input.key);
      if (prior) {
        if (prior.fingerprint !== input.fingerprint) {
          throw new OpsError(OPS_IDEMPOTENCY_CONFLICT, 'This idempotency key was already used for a different template.');
        }
        return prior.row;
      }
      const prepared = preparedTemplate(input);
      const current = templates.get(input.name) ?? null;
      if (current && input.expectedVersion === undefined) {
        throw new OpsError(OPS_TEMPLATE_NAME_TAKEN, `A template named ${input.name} already exists. Nothing was saved.`);
      }
      if (current?.version !== input.expectedVersion && !(current === null && input.expectedVersion === undefined)) {
        throw new OpsError(
          OPS_ALERT_TEMPLATE_VERSION_STALE,
          current
            ? `The template is at version ${current.version}, not ${input.expectedVersion ?? 'a new template'}.`
            : 'No such template to update.',
        );
      }
      assertTemplateVariablesSavable(policy, prepared.title, prepared.body, prepared.variables);
      const row: TemplateRow = {
        name: input.name,
        title: prepared.title,
        body: prepared.body,
        variables: prepared.variables,
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
      if (missing.length > 0) throw new OpsError(OPS_ALERT_LABEL_REQUIRED, enforcedMessage(missing));
    },
  };
}

const iso = (d: Date) => d.toISOString();

type BeatInput = Parameters<AlertDeskStore['recordHeartbeat']>[0];

function templateFrom(row: {
  name: string;
  title: string;
  body: string;
  variables: TemplateVariable[];
  version: number;
  actor: string;
  reason: string;
  at: Date;
}): TemplateRow {
  return {
    name: row.name,
    title: row.title,
    body: row.body,
    variables: row.variables,
    version: row.version,
    actor: row.actor,
    reason: row.reason,
    updatedAt: iso(row.at),
  };
}

export function createPgAlertDesk(sql: Sql): AlertDeskStore {
  const writeBeat = async (table: 'ops.alert_heartbeats' | 'ops.alert_test_beats', input: BeatInput): Promise<HeartbeatRow> => {
    const actor = assertActor(input.actor);
    return sql.begin(async (tx) => {
      const [prior] =
        table === 'ops.alert_heartbeats'
          ? await tx<{ actor: string; reason: string; recorded_at: Date; fingerprint: string }[]>`
              SELECT actor, reason, recorded_at, fingerprint FROM ops.alert_heartbeats WHERE idempotency_key = ${input.key}`
          : await tx<{ actor: string; reason: string; recorded_at: Date; fingerprint: string }[]>`
              SELECT actor, reason, recorded_at, fingerprint FROM ops.alert_test_beats WHERE idempotency_key = ${input.key}`;
      if (prior) {
        if (prior.fingerprint !== input.fingerprint) {
          throw new OpsError(OPS_IDEMPOTENCY_CONFLICT, 'This idempotency key was already used for a different heartbeat.');
        }
        return { key: input.key, actor: prior.actor, reason: prior.reason, recordedAt: iso(prior.recorded_at) };
      }
      if (table === 'ops.alert_heartbeats') {
        await tx`
          INSERT INTO ops.alert_heartbeats (idempotency_key, fingerprint, actor, reason, recorded_at)
          VALUES (${input.key}, ${input.fingerprint}, ${actor}, ${input.reason}, ${input.at})`;
      } else {
        await tx`
          INSERT INTO ops.alert_test_beats (idempotency_key, fingerprint, actor, reason, recorded_at)
          VALUES (${input.key}, ${input.fingerprint}, ${actor}, ${input.reason}, ${input.at})`;
      }
      return { key: input.key, actor, reason: input.reason, recordedAt: input.at };
    });
  };

  return {
    recordHeartbeat(input) {
      return writeBeat('ops.alert_heartbeats', input);
    },
    recordTestBeat(input) {
      return writeBeat('ops.alert_test_beats', input);
    },
    async latestHeartbeat() {
      const [row] = await sql<{ idempotency_key: string; actor: string; reason: string; recorded_at: Date }[]>`
        SELECT idempotency_key, actor, reason, recorded_at FROM ops.alert_heartbeats ORDER BY id DESC LIMIT 1`;
      return row ? { key: row.idempotency_key, actor: row.actor, reason: row.reason, recordedAt: iso(row.recorded_at) } : null;
    },
    async saveTemplate(input) {
      const actor = assertActor(input.actor);
      const prepared = preparedTemplate(input);
      return sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext(${`ops.alert.template:${input.name}`}))`;
        const [prior] = await tx<
          {
            fingerprint: string;
            title: string;
            body: string;
            variables: TemplateVariable[];
            version: number;
            actor: string;
            reason: string;
            at: Date;
            name: string;
          }[]
        >`
          SELECT name, title, body, variables, version, actor, reason, at, fingerprint
          FROM ops.alert_template_versions WHERE idempotency_key = ${input.key}`;
        if (prior) {
          if (prior.fingerprint !== input.fingerprint) {
            throw new OpsError(OPS_IDEMPOTENCY_CONFLICT, 'This idempotency key was already used for a different template.');
          }
          return templateFrom(prior);
        }
        const [current] = await tx<{ version: number }[]>`SELECT version FROM ops.alert_templates WHERE name = ${input.name}`;
        const currentVersion = current?.version;
        if (current && input.expectedVersion === undefined) {
          throw new OpsError(OPS_TEMPLATE_NAME_TAKEN, `A template named ${input.name} already exists. Nothing was saved.`);
        }
        if (currentVersion !== input.expectedVersion && !(currentVersion === undefined && input.expectedVersion === undefined)) {
          throw new OpsError(
            OPS_ALERT_TEMPLATE_VERSION_STALE,
            currentVersion !== undefined
              ? `The template is at version ${currentVersion}, not ${input.expectedVersion ?? 'a new template'}.`
              : 'No such template to update.',
          );
        }
        const [policyRow] = await tx<{ requirements: QualityRequirement[] }[]>`
          SELECT requirements FROM ops.alert_quality_policy WHERE id = 1`;
        const policy = policyRow ? { requirements: policyRow.requirements } : null;
        assertTemplateVariablesSavable(policy, prepared.title, prepared.body, prepared.variables);
        const version = (currentVersion ?? 0) + 1;
        if (!current) {
          await tx`INSERT INTO ops.alert_templates (name, title, body, variables, version, actor, reason, updated_at)
            VALUES (${input.name}, ${prepared.title}, ${prepared.body}, ${tx.json(prepared.variables as never)}, ${version}, ${actor}, ${input.reason}, ${input.at})`;
        } else {
          await tx`UPDATE ops.alert_templates
            SET title = ${prepared.title}, body = ${prepared.body}, variables = ${tx.json(prepared.variables as never)}, version = ${version},
                actor = ${actor}, reason = ${input.reason}, updated_at = ${input.at}
            WHERE name = ${input.name}`;
        }
        await tx`INSERT INTO ops.alert_template_versions
          (name, version, title, body, variables, actor, reason, idempotency_key, fingerprint, at)
          VALUES (${input.name}, ${version}, ${prepared.title}, ${prepared.body}, ${tx.json(prepared.variables as never)}, ${actor}, ${input.reason},
                  ${input.key}, ${input.fingerprint}, ${input.at})`;
        return {
          name: input.name,
          title: prepared.title,
          body: prepared.body,
          variables: prepared.variables,
          version,
          actor,
          reason: input.reason,
          updatedAt: input.at,
        };
      });
    },
    async getTemplate(name) {
      const [row] = await sql<
        {
          name: string;
          title: string;
          body: string;
          variables: TemplateVariable[];
          version: number;
          actor: string;
          reason: string;
          updated_at: Date;
        }[]
      >`
        SELECT name, title, body, variables, version, actor, reason, updated_at FROM ops.alert_templates WHERE name = ${name}`;
      return row ? templateFrom({ ...row, at: row.updated_at }) : null;
    },
    async listTemplates(limit) {
      const rows = await sql<
        {
          name: string;
          title: string;
          body: string;
          variables: TemplateVariable[];
          version: number;
          actor: string;
          reason: string;
          updated_at: Date;
        }[]
      >`
        SELECT name, title, body, variables, version, actor, reason, updated_at FROM ops.alert_templates ORDER BY name LIMIT ${limit}`;
      return rows.map((row) => templateFrom({ ...row, at: row.updated_at }));
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
      if (missing.length > 0) throw new OpsError(OPS_ALERT_LABEL_REQUIRED, enforcedMessage(missing));
    },
  };
}
