import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { hasScope } from '@intafaced/auth';
import {
  OPS_ALERT_HEALTH,
  OPS_ALERT_STATES,
  opsAlertRuleDraftSchema,
  opsAlertRuleSchema,
  router,
  scopedProcedure,
} from '@intafaced/contracts';
import {
  OPS_ALERT_FORBIDDEN,
  OPS_ALERT_HISTORY_RETENTION_UNSET,
  OPS_ALERT_LIST_LIMIT_UNSET,
  OPS_ALERT_RULE_NOT_FOUND,
  OPS_ALERT_RULE_VERSION_STALE,
  OPS_ALERT_STORAGE_UNCONFIGURED,
  OPS_IDEMPOTENCY_CONFLICT,
  OpsError,
} from '../codes.js';
import { assertIdempotencyKey } from '../operator-desks.js';
import { assertOpsListLimit } from '../list-limit.js';
import type { Actor, AlertRules, RuleCursor } from './rules.js';
import type { AlertStateStore } from './state-store.js';

const guards = { module: 'core-ops' as const, plane: 'fiat' as const };

const keyField = z.string();
const reasonField = z.string().trim().min(1).max(500);
const versionField = z.number().int().min(1);

const cursorSchema = z.string().min(1).max(600);
const encodeCursor = (c: RuleCursor) => Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
function decodeCursor(raw: string): RuleCursor {
  try {
    const parsed = z
      .object({ folder: z.string(), group: z.string(), name: z.string(), id: z.string() })
      .parse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')));
    return parsed;
  } catch {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'cursor is not one this list returned' });
  }
}

const stateSchema = z.object({
  instance: z.string(),
  state: z.enum(OPS_ALERT_STATES),
  health: z.enum(OPS_ALERT_HEALTH),
  epoch: z.number().int(),
  pendingSince: z.string().nullable(),
  firingSince: z.string().nullable(),
  lastEvaluatedAt: z.string(),
  lastValue: z.string().nullable(),
  lastCode: z.string().nullable(),
  /** The rule says keep last and the latest check was unhealthy: the state is the earlier one. */
  kept: z.boolean(),
});

const historyRowSchema = z.object({
  id: z.number().int(),
  ruleId: z.string().uuid(),
  instance: z.string(),
  epoch: z.number().int(),
  at: z.string(),
  from: z.enum(OPS_ALERT_STATES),
  to: z.enum(OPS_ALERT_STATES),
  health: z.enum(OPS_ALERT_HEALTH),
  value: z.string().nullable(),
  code: z.string().nullable(),
});

const versionSchema = z.object({
  version: z.number().int().min(1),
  change: z.enum(['created', 'updated', 'paused', 'resumed', 'retired', 'restored']),
  actor: z.string(),
  reason: z.string(),
  at: z.string(),
  rule: opsAlertRuleSchema,
});

function alertError(err: unknown): never {
  if (err instanceof OpsError) {
    const code =
      err.code === OPS_ALERT_FORBIDDEN
        ? 'FORBIDDEN'
        : err.code === OPS_ALERT_RULE_NOT_FOUND
          ? 'NOT_FOUND'
          : err.code === OPS_IDEMPOTENCY_CONFLICT || err.code === OPS_ALERT_RULE_VERSION_STALE
            ? 'CONFLICT'
            : 'PRECONDITION_FAILED';
    throw new TRPCError({ code, message: `${err.code} — ${err.message}`, cause: err });
  }
  throw err;
}

export function createAlertRulesRouter(rules: AlertRules | undefined, stateStore?: AlertStateStore) {
  const need = (): AlertRules => {
    if (!rules) {
      throw new OpsError(
        OPS_ALERT_STORAGE_UNCONFIGURED,
        'No durable storage is configured for alert rules. Nothing was saved, and no rule is listed.',
      );
    }
    return rules;
  };
  const writer = scopedProcedure('admin:write', guards);
  const staff = (ctx: { principal: { userId: string; mfa: boolean } }, input: { reason: string; idempotencyKey: string }): Actor => {
    if (!ctx.principal.mfa) throw new OpsError(OPS_ALERT_FORBIDDEN, 'Changing an alert rule needs a second factor on this session.');
    return { id: ctx.principal.userId, reason: input.reason, key: assertIdempotencyKey(input.idempotencyKey) };
  };
  const guarded = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (err) {
      return alertError(err);
    }
  };
  const rule = opsAlertRuleSchema;

  return router({
    list: scopedProcedure('admin:read', guards)
      .input(
        z.object({
          limit: z.number().int().min(1).max(200).optional(),
          folder: z.string().optional(),
          group: z.string().optional(),
          name: z.string().max(120).optional(),
          label: z.object({ key: z.string(), value: z.string() }).optional(),
          includeRetired: z.boolean().optional(),
          cursor: cursorSchema.optional(),
        }),
      )
      .output(z.object({ rules: z.array(rule), nextCursor: z.string().nullable() }))
      .query(({ input }) =>
        guarded(async () => {
          const store = need();
          const limit = assertOpsListLimit(input.limit, OPS_ALERT_LIST_LIMIT_UNSET);
          const found = await store.list({
            ...(input.folder !== undefined ? { folder: input.folder } : {}),
            ...(input.group !== undefined ? { group: input.group } : {}),
            ...(input.name !== undefined ? { nameContains: input.name } : {}),
            ...(input.label ? { label: input.label } : {}),
            ...(input.cursor ? { after: decodeCursor(input.cursor) } : {}),
            includeRetired: input.includeRetired ?? false,
            limit: limit + 1,
          });
          const page = found.slice(0, limit);
          const last = page[page.length - 1];
          return {
            rules: page,
            nextCursor:
              found.length > limit && last ? encodeCursor({ folder: last.folder, group: last.group, name: last.name, id: last.id }) : null,
          };
        }),
      ),

    /** Rules with their stored state and health. A rule that has not been evaluated yet says so; no state is invented. */
    states: scopedProcedure('admin:read', guards)
      .input(
        z.object({
          limit: z.number().int().min(1).max(200).optional(),
          folder: z.string().optional(),
          group: z.string().optional(),
          name: z.string().max(120).optional(),
          label: z.object({ key: z.string(), value: z.string() }).optional(),
          state: z.enum(OPS_ALERT_STATES).optional(),
          health: z.enum(OPS_ALERT_HEALTH).optional(),
          cursor: cursorSchema.optional(),
        }),
      )
      .output(z.object({ items: z.array(z.object({ rule, status: stateSchema.nullable() })), nextCursor: z.string().nullable() }))
      .query(({ input }) =>
        guarded(async () => {
          const store = need();
          const states = stateStore;
          const limit = assertOpsListLimit(input.limit, OPS_ALERT_LIST_LIMIT_UNSET);
          const wanted = input.state !== undefined || input.health !== undefined;
          const items: { rule: z.infer<typeof rule>; status: z.infer<typeof stateSchema> | null }[] = [];
          let cursor = input.cursor ? decodeCursor(input.cursor) : undefined;
          let more = false;
          for (let pages = 0; pages < 50 && items.length <= limit; pages++) {
            const found = await store.list({
              ...(input.folder !== undefined ? { folder: input.folder } : {}),
              ...(input.group !== undefined ? { group: input.group } : {}),
              ...(input.name !== undefined ? { nameContains: input.name } : {}),
              ...(input.label ? { label: input.label } : {}),
              ...(cursor ? { after: cursor } : {}),
              includeRetired: false,
              limit: 200,
            });
            const byRule = states ? await states.states(found.map((r) => r.id)) : new Map();
            for (const r of found) {
              const status = byRule.get(r.id) ?? null;
              if (
                wanted &&
                (!status ||
                  (input.state !== undefined && status.state !== input.state) ||
                  (input.health !== undefined && status.health !== input.health))
              )
                continue;
              items.push({ rule: r, status });
            }
            const last = found[found.length - 1];
            more = found.length === 200;
            if (!more || !last) break;
            cursor = { folder: last.folder, group: last.group, name: last.name, id: last.id };
          }
          const page = items.slice(0, limit);
          const last = page[page.length - 1]?.rule;
          return {
            items: page,
            nextCursor:
              (items.length > limit || more) && last
                ? encodeCursor({ folder: last.folder, group: last.group, name: last.name, id: last.id })
                : null,
          };
        }),
      ),

    /** State changes, newest first, capped at the page size you pass; a cut page says so and the filters narrow it. */
    history: scopedProcedure('admin:read', guards)
      .input(
        z.object({
          limit: z.number().int().min(1).max(200).optional(),
          ruleId: z.string().uuid().optional(),
          state: z.enum(OPS_ALERT_STATES).optional(),
          since: z.string().datetime({ offset: true }).optional(),
          until: z.string().datetime({ offset: true }).optional(),
        }),
      )
      .output(
        z.object({
          rows: z.array(historyRowSchema),
          truncated: z.boolean(),
          cap: z.number().int(),
          retention: z.object({ configured: z.literal(false), code: z.literal(OPS_ALERT_HISTORY_RETENTION_UNSET) }),
        }),
      )
      .query(({ input }) =>
        guarded(async () => {
          need();
          if (!stateStore) {
            throw new OpsError(OPS_ALERT_STORAGE_UNCONFIGURED, 'No durable storage is configured for alert state. No history is listed.');
          }
          const limit = assertOpsListLimit(input.limit, OPS_ALERT_LIST_LIMIT_UNSET);
          const out = await stateStore.history({
            limit,
            ...(input.ruleId ? { ruleId: input.ruleId } : {}),
            ...(input.state ? { state: input.state } : {}),
            ...(input.since ? { since: input.since } : {}),
            ...(input.until ? { until: input.until } : {}),
          });
          // No retention period is set, so nothing is pruned: the owner value is blank and says so.
          return {
            rows: [...out.rows],
            truncated: out.truncated,
            cap: limit,
            retention: { configured: false as const, code: OPS_ALERT_HISTORY_RETENTION_UNSET },
          };
        }),
      ),

    get: scopedProcedure('admin:read', guards)
      .input(z.object({ id: z.string().uuid() }))
      .output(rule)
      .query(({ input }) =>
        guarded(async () => {
          const found = await need().get(input.id);
          if (!found) throw new OpsError(OPS_ALERT_RULE_NOT_FOUND, 'No such alert rule.');
          return found;
        }),
      ),

    versions: scopedProcedure('admin:read', guards)
      .input(z.object({ id: z.string().uuid(), limit: z.number().int().min(1).max(200).optional() }))
      .output(z.object({ versions: z.array(versionSchema) }))
      .query(({ input }) =>
        guarded(async () => ({
          versions: [...(await need().versions(input.id, assertOpsListLimit(input.limit, OPS_ALERT_LIST_LIMIT_UNSET)))],
        })),
      ),

    create: writer
      .input(opsAlertRuleDraftSchema.extend({ idempotencyKey: keyField }))
      .output(rule)
      .mutation(({ ctx, input }) =>
        guarded(async () => {
          const { idempotencyKey, ...draft } = input;
          return need().create(draft, staff(ctx, { reason: input.reason, idempotencyKey }));
        }),
      ),

    update: writer
      .input(opsAlertRuleDraftSchema.extend({ id: z.string().uuid(), expectedVersion: versionField, idempotencyKey: keyField }))
      .output(rule)
      .mutation(({ ctx, input }) =>
        guarded(async () => {
          const { idempotencyKey, id, expectedVersion, ...draft } = input;
          return need().update(id, expectedVersion, draft, staff(ctx, { reason: input.reason, idempotencyKey }));
        }),
      ),

    setPaused: writer
      .input(
        z.object({
          id: z.string().uuid(),
          expectedVersion: versionField,
          paused: z.boolean(),
          reason: reasonField,
          idempotencyKey: keyField,
        }),
      )
      .output(rule)
      .mutation(({ ctx, input }) =>
        guarded(async () => need().setPaused(input.id, input.expectedVersion, input.paused, staff(ctx, input))),
      ),

    retire: writer
      .input(z.object({ id: z.string().uuid(), expectedVersion: versionField, reason: reasonField, idempotencyKey: keyField }))
      .output(rule)
      .mutation(({ ctx, input }) => guarded(async () => need().retire(input.id, input.expectedVersion, staff(ctx, input)))),

    /** Only an admin restores a retired rule: the treasury-grade scope, which also needs a second factor. */
    restore: writer
      .input(z.object({ id: z.string().uuid(), expectedVersion: versionField, reason: reasonField, idempotencyKey: keyField }))
      .output(rule)
      .mutation(({ ctx, input }) =>
        guarded(async () => {
          if (!hasScope(ctx.principal.scopes, 'admin:treasury')) {
            throw new OpsError(OPS_ALERT_FORBIDDEN, 'Only an admin restores a retired alert rule.');
          }
          return need().restore(input.id, input.expectedVersion, staff(ctx, input));
        }),
      ),
  });
}
