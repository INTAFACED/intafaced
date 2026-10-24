/**
 * OPS-alerts-03 reads and writes: the active-alert overview, a heartbeat, templates and the quality policy.
 * `alerts.list` stays the unprobed external source. This file does not send a notification and does not invent a count.
 */
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router, scopedProcedure } from '@intafaced/contracts';
import type { AlertRules } from './rules.js';
import type { AlertStateStore } from './state-store.js';
import { fingerprintOf, missingRequirements, previewTemplate, type AlertDeskStore, type HeartbeatRow } from './desk-store.js';
import {
  OPS_ALERT_ACTOR_UNSET,
  OPS_ALERT_FORBIDDEN,
  OPS_ALERT_HEARTBEAT_ABSENT,
  OPS_ALERT_LIST_LIMIT_UNSET,
  OPS_ALERT_QUALITY_NOTHING_REQUIRED,
  OPS_ALERT_QUALITY_POLICY_UNSET,
  OPS_ALERT_STORAGE_UNCONFIGURED,
  OPS_ALERT_TEMPLATE_NOT_FOUND,
  OPS_HEARTBEAT_WINDOW_UNSET,
  OPS_IDEMPOTENCY_CONFLICT,
  OPS_ALERT_QUALITY_VERSION_STALE,
  OPS_ALERT_TEMPLATE_VERSION_STALE,
  OPS_TEMPLATE_NAME_TAKEN,
  OpsError,
} from '../codes.js';
import { assertIdempotencyKey } from '../operator-desks.js';
import { assertOpsListLimit } from '../list-limit.js';

const guards = { module: 'core-ops' as const, plane: 'fiat' as const };
const reasonField = z.string().trim().min(1).max(500);
const requirementSchema = z.object({
  kind: z.enum(['annotation', 'label']),
  key: z.string().min(1).max(64),
  mode: z.enum(['detect', 'enforce']),
});

export function heartbeatJudgement(last: HeartbeatRow | null, maxAgeSeconds: number | null, nowIso: string) {
  if (maxAgeSeconds === null) {
    return { last, maxAgeSeconds: null, overdue: null, code: OPS_HEARTBEAT_WINDOW_UNSET };
  }
  if (!last) {
    return { last: null, maxAgeSeconds, overdue: null, code: OPS_ALERT_HEARTBEAT_ABSENT };
  }
  const ageMs = Date.parse(nowIso) - Date.parse(last.recordedAt);
  return { last, maxAgeSeconds, overdue: ageMs > maxAgeSeconds * 1000, code: null };
}

function deskError(err: unknown): never {
  if (err instanceof OpsError) {
    const code =
      err.code === OPS_ALERT_FORBIDDEN
        ? 'FORBIDDEN'
        : err.code === OPS_ALERT_TEMPLATE_NOT_FOUND
          ? 'NOT_FOUND'
          : err.code === OPS_IDEMPOTENCY_CONFLICT ||
              err.code === OPS_ALERT_TEMPLATE_VERSION_STALE ||
              err.code === OPS_ALERT_QUALITY_VERSION_STALE ||
              err.code === OPS_TEMPLATE_NAME_TAKEN
            ? 'CONFLICT'
            : 'PRECONDITION_FAILED';
    throw new TRPCError({ code, message: `${err.code} — ${err.message}`, cause: err });
  }
  throw err;
}

function actorOf(userId: string): string {
  return userId;
}

export interface AlertDeskDeps {
  readonly now: () => string;
  readonly alertState?: AlertStateStore;
  readonly alertRules?: AlertRules;
  readonly alertDesk?: AlertDeskStore;
  /** Blank owner window. Null means overdue is not computed. */
  readonly alertHeartbeatMaxAgeSeconds?: number | null;
}

export function createAlertDeskRoutes(deps: AlertDeskDeps) {
  const needDesk = (): AlertDeskStore => {
    if (!deps.alertDesk) {
      throw new OpsError(
        OPS_ALERT_STORAGE_UNCONFIGURED,
        'No durable storage is configured for the alert desk. Nothing was saved or listed.',
      );
    }
    return deps.alertDesk;
  };
  const writer = scopedProcedure('admin:write', guards);
  const reader = scopedProcedure('admin:read', guards);
  const staff = (ctx: { principal: { userId: string; mfa: boolean } }, reason: string, key: string) => {
    if (!ctx.principal.mfa) throw new OpsError(OPS_ALERT_FORBIDDEN, 'This write needs a second factor on this session.');
    if (!ctx.principal.userId.trim()) throw new OpsError(OPS_ALERT_ACTOR_UNSET, 'The operator id is blank. Nothing was saved.');
    return { actor: actorOf(ctx.principal.userId.trim()), reason, key: assertIdempotencyKey(key) };
  };

  const activity = reader
    .input(z.object({ limit: z.number().int().min(1).max(200).optional(), state: z.enum(['pending', 'firing']).optional() }))
    .output(
      z.object({
        asOf: z.string(),
        items: z.array(
          z.object({
            ruleId: z.string().guid(),
            ruleName: z.string().nullable(),
            instance: z.string(),
            state: z.enum(['pending', 'firing']),
            health: z.enum(['ok', 'error', 'no_data']),
            epoch: z.number().int(),
            pendingSince: z.string().nullable(),
            firingSince: z.string().nullable(),
            lastEvaluatedAt: z.string(),
            lastValue: z.string().nullable(),
            lastCode: z.string().nullable(),
            panel: z.object({ dashboardUid: z.string(), panelId: z.string() }).nullable(),
          }),
        ),
        truncated: z.boolean(),
      }),
    )
    .query(({ input }) =>
      (async () => {
        try {
          if (!deps.alertState) {
            throw new OpsError(
              OPS_ALERT_STORAGE_UNCONFIGURED,
              'No durable storage is configured for alert state. No active alert is listed.',
            );
          }
          const limit = assertOpsListLimit(input.limit, OPS_ALERT_LIST_LIMIT_UNSET);
          const states = input.state ? [input.state] : (['firing', 'pending'] as const);
          const found = await deps.alertState.active(states, limit + 1);
          const page = found.slice(0, limit);
          const items = await Promise.all(
            page.map(async (row) => {
              const rule = deps.alertRules ? await deps.alertRules.get(row.ruleId) : null;
              const dash = rule?.annotations.dashboardUid;
              const panelId = rule?.annotations.panelId;
              const state = row.state === 'firing' || row.state === 'pending' ? row.state : 'firing';
              return {
                ruleId: row.ruleId,
                ruleName: rule?.name ?? null,
                instance: row.instance,
                state,
                health: row.health,
                epoch: row.epoch,
                pendingSince: row.pendingSince,
                firingSince: row.firingSince,
                lastEvaluatedAt: row.lastEvaluatedAt,
                lastValue: row.lastValue,
                lastCode: row.lastCode,
                panel: dash && panelId ? { dashboardUid: dash, panelId } : null,
              };
            }),
          );
          return { asOf: deps.now(), items, truncated: found.length > limit };
        } catch (err) {
          return deskError(err);
        }
      })(),
    );

  const heartbeat = writer
    .input(z.object({ reason: reasonField, idempotencyKey: z.string() }))
    .output(z.object({ key: z.string(), actor: z.string(), reason: z.string(), recordedAt: z.string() }))
    .mutation(({ ctx, input }) =>
      (async () => {
        try {
          const who = staff(ctx, input.reason, input.idempotencyKey);
          // A pressed beat is a test. It is not the pipeline beat heartbeatStatus reads.
          return await needDesk().recordTestBeat({
            key: who.key,
            fingerprint: fingerprintOf({ reason: input.reason }),
            actor: who.actor,
            reason: input.reason,
            at: deps.now(),
          });
        } catch (err) {
          return deskError(err);
        }
      })(),
    );

  const heartbeatStatus = reader
    .output(
      z.object({
        last: z.object({ key: z.string(), actor: z.string(), reason: z.string(), recordedAt: z.string() }).nullable(),
        maxAgeSeconds: z.number().int().positive().nullable(),
        overdue: z.boolean().nullable(),
        code: z.string().nullable(),
      }),
    )
    .query(() =>
      (async () => {
        try {
          if (!deps.alertDesk) {
            throw new OpsError(OPS_ALERT_STORAGE_UNCONFIGURED, 'No durable storage is configured for heartbeats. No beat is listed.');
          }
          const last = await deps.alertDesk.latestHeartbeat();
          return heartbeatJudgement(last, deps.alertHeartbeatMaxAgeSeconds ?? null, deps.now());
        } catch (err) {
          return deskError(err);
        }
      })(),
    );

  const variableSchema = z.object({ name: z.string().min(1).max(63), source: z.enum(['label', 'query']) });
  const templateRow = z.object({
    name: z.string(),
    title: z.string(),
    body: z.string(),
    variables: z.array(variableSchema),
    version: z.number().int(),
    actor: z.string(),
    reason: z.string(),
    updatedAt: z.string(),
  });
  const previewData = z.discriminatedUnion('sample', [
    z.object({ sample: z.literal('TEST') }),
    z.object({
      sample: z.literal('custom'),
      labels: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,62}$/), z.string().max(200)).optional(),
      query: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,62}$/), z.string().max(200)).optional(),
    }),
  ]);
  const previewOut = z.object({
    title: z.string(),
    body: z.string(),
    missing: z.array(z.string()),
    sample: z.enum(['TEST', 'custom']),
  });

  const templates = router({
    list: reader
      .input(z.object({ limit: z.number().int().min(1).max(200).optional() }))
      .output(z.object({ templates: z.array(templateRow) }))
      .query(({ input }) =>
        (async () => {
          try {
            const limit = assertOpsListLimit(input.limit, OPS_ALERT_LIST_LIMIT_UNSET);
            return { templates: [...(await needDesk().listTemplates(limit))] };
          } catch (err) {
            return deskError(err);
          }
        })(),
      ),
    get: reader
      .input(z.object({ name: z.string() }))
      .output(templateRow)
      .query(({ input }) =>
        (async () => {
          try {
            const found = await needDesk().getTemplate(input.name);
            if (!found) throw new OpsError(OPS_ALERT_TEMPLATE_NOT_FOUND, 'No such template.');
            return found;
          } catch (err) {
            return deskError(err);
          }
        })(),
      ),
    preview: reader
      .input(
        z.union([
          z.object({ name: z.string(), data: previewData }),
          z.object({
            title: z.string().max(500),
            body: z.string().max(4000),
            variables: z.array(variableSchema).max(40),
            data: previewData,
          }),
        ]),
      )
      .output(previewOut)
      .query(({ input }) =>
        (async () => {
          try {
            const source =
              'name' in input
                ? await (async () => {
                    const found = await needDesk().getTemplate(input.name);
                    if (!found) throw new OpsError(OPS_ALERT_TEMPLATE_NOT_FOUND, 'No such template.');
                    return found;
                  })()
                : { title: input.title, body: input.body, variables: input.variables };
            const rendered = previewTemplate({
              title: source.title,
              body: source.body,
              variables: source.variables,
              data: input.data.sample === 'TEST' ? { sample: 'TEST' } : input.data,
            });
            return { ...rendered, missing: [...rendered.missing] };
          } catch (err) {
            return deskError(err);
          }
        })(),
      ),
    save: writer
      .input(
        z.object({
          name: z.string().regex(/^[a-z][a-z0-9_-]{0,62}$/),
          title: z.string().max(500),
          body: z.string().max(4000),
          variables: z.array(variableSchema).max(40),
          reason: reasonField,
          idempotencyKey: z.string(),
          expectedVersion: z.number().int().min(1).optional(),
        }),
      )
      .output(templateRow)
      .mutation(({ ctx, input }) =>
        (async () => {
          try {
            const who = staff(ctx, input.reason, input.idempotencyKey);
            return await needDesk().saveTemplate({
              name: input.name,
              title: input.title,
              body: input.body,
              variables: input.variables,
              ...(input.expectedVersion !== undefined ? { expectedVersion: input.expectedVersion } : {}),
              key: who.key,
              fingerprint: fingerprintOf({
                name: input.name,
                title: input.title.trim(),
                body: input.body.trim(),
                variables: input.variables,
                expectedVersion: input.expectedVersion ?? null,
              }),
              actor: who.actor,
              reason: input.reason,
              at: deps.now(),
            });
          } catch (err) {
            return deskError(err);
          }
        })(),
      ),
  });

  const policySchema = z.object({
    version: z.number().int(),
    requirements: z.array(requirementSchema),
    actor: z.string(),
    reason: z.string(),
    updatedAt: z.string(),
  });

  const quality = router({
    get: reader.output(z.object({ policy: policySchema.nullable(), code: z.string().nullable() })).query(() =>
      (async () => {
        try {
          const policy = await needDesk().getPolicy();
          if (!policy) return { policy: null, code: OPS_ALERT_QUALITY_POLICY_UNSET };
          if (policy.requirements.length === 0) return { policy, code: OPS_ALERT_QUALITY_NOTHING_REQUIRED };
          return { policy, code: null };
        } catch (err) {
          return deskError(err);
        }
      })(),
    ),
    set: writer
      .input(
        z.object({
          requirements: z.array(requirementSchema).max(20),
          reason: reasonField,
          idempotencyKey: z.string(),
          expectedVersion: z.number().int().min(1).optional(),
        }),
      )
      .output(policySchema)
      .mutation(({ ctx, input }) =>
        (async () => {
          try {
            const who = staff(ctx, input.reason, input.idempotencyKey);
            return await needDesk().savePolicy({
              requirements: input.requirements,
              ...(input.expectedVersion !== undefined ? { expectedVersion: input.expectedVersion } : {}),
              key: who.key,
              fingerprint: fingerprintOf({
                requirements: input.requirements,
                expectedVersion: input.expectedVersion ?? null,
              }),
              actor: who.actor,
              reason: input.reason,
              at: deps.now(),
            });
          } catch (err) {
            return deskError(err);
          }
        })(),
      ),
    findings: reader
      .input(z.object({ limit: z.number().int().min(1).max(200).optional() }))
      .output(
        z.object({
          findings: z
            .array(
              z.object({
                ruleId: z.string().guid(),
                name: z.string(),
                missing: z.array(z.object({ kind: z.enum(['annotation', 'label']), key: z.string(), mode: z.enum(['detect', 'enforce']) })),
              }),
            )
            .nullable(),
          checked: z.number().int().nullable(),
          truncated: z.boolean().nullable(),
          code: z.string().nullable(),
        }),
      )
      .query(({ input }) =>
        (async () => {
          try {
            const desk = needDesk();
            const policy = await desk.getPolicy();
            if (!policy) return { findings: null, checked: null, truncated: null, code: OPS_ALERT_QUALITY_POLICY_UNSET };
            if (policy.requirements.length === 0) {
              return { findings: null, checked: null, truncated: null, code: OPS_ALERT_QUALITY_NOTHING_REQUIRED };
            }
            if (!deps.alertRules) {
              throw new OpsError(OPS_ALERT_STORAGE_UNCONFIGURED, 'No durable storage is configured for alert rules. No finding is listed.');
            }
            const limit = assertOpsListLimit(input.limit, OPS_ALERT_LIST_LIMIT_UNSET);
            const rules = await deps.alertRules.list({ includeRetired: false, limit: limit + 1 });
            const page = rules.slice(0, limit);
            const findings = page.flatMap((rule) => {
              const missing = missingRequirements(rule, policy.requirements);
              return missing.length === 0 ? [] : [{ ruleId: rule.id, name: rule.name, missing: [...missing] }];
            });
            return { findings, checked: page.length, truncated: rules.length > limit, code: null };
          } catch (err) {
            return deskError(err);
          }
        })(),
      ),
  });

  return { activity, heartbeat, heartbeatStatus, templates, quality };
}
