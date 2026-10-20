import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { hasScope } from '@intafaced/auth';
import { opsAlertRuleDraftSchema, opsAlertRuleSchema, router, scopedProcedure } from '@intafaced/contracts';
import {
  OPS_ALERT_FORBIDDEN,
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

export function createAlertRulesRouter(rules: AlertRules | undefined) {
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
