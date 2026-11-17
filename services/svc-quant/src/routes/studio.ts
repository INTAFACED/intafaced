import { QUANT_SIGNAL_RULES_SANDBOX, QUANT_VERSION_NOT_FOUND, QuantError } from '../errors.js';
import { STUDIO_LIST_LIMIT_CAP, assertStudioListLimit } from '../studio/list-limit.js';
import { buildSavedStrategy } from '../studio/save.js';
import { compileSignalRules } from '../studio/modules.js';
import { draftOf } from '../studio/repository.js';
import { idempotencyConflict, requireClientStrategyId, requireIdempotencyKey } from '../studio/keys.js';
import {
  publicJurisdictionProcedure,
  quantCompileOutputSchema,
  quantSignalRulesSchema,
  quantVersionDiffSchema,
  router,
} from '@intafaced/contracts';
import { requireStudioOperator } from '../studio/scope.js';
import { runSandbox } from '../sandbox/run.js';
import { trackRun } from '../runs/track.js';
import { versionDiff } from '../studio/diff.js';
import { withQuantSpan } from '../tracing.js';
import { z } from 'zod';
import {
  environmentInput,
  decimal,
  runOutput,
  organisationOf,
  toTrpc,
  studioBlock,
  studioRisk,
  strategyHead,
  strategyDetail,
  strategyDetailForLive,
  sandboxBody,
  strategyMetadata,
  accountField,
  writeKeyField,
  clientIdField,
  missingStrategy,
  type QuantCore,
} from './core.js';

export function studioRoutes(core: QuantCore) {
  const { strategies, runs, approvals, approvedVersionsOf, runLimitsFor, runDeps, releaseNoteOf, replayOf, accountOf, refuseWhileLocked } =
    core;
  return router({
    save: publicJurisdictionProcedure('quant', 'fiat')
      .input(
        z
          .object({
            name: z.string().min(1).max(128),
            blocks: z.array(studioBlock),
            modules: quantSignalRulesSchema.optional().nullable(),
            risk: studioRisk,
            cash: decimal.optional().nullable(),
            ...accountField,
            ...writeKeyField,
            ...clientIdField,
            releaseNote: z.string().max(2000).optional(),
          })
          .merge(environmentInput),
      )
      .output(strategyDetail)
      .mutation(async ({ input, ctx }) =>
        withQuantSpan('quant.studio.save', { language: 'javascript' }, async () => {
          try {
            const accountId = accountOf(ctx, input.accountId);
            const prior = await replayOf(accountId, input.idempotencyKey);
            if (prior?.operation === 'create') return prior.response;
            if (prior) idempotencyConflict(prior.operation);
            const built = buildSavedStrategy(input, 'studio_pending');
            const releaseNote = releaseNoteOf(input.releaseNote);
            return await strategies.create({
              accountId,
              clientStrategyId: requireClientStrategyId(input.clientStrategyId),
              idempotencyKey: requireIdempotencyKey(input.idempotencyKey),
              draft: { ...draftOf(built), releaseNote },
            });
          } catch (err) {
            toTrpc(err);
          }
        }),
      ),

    /**
     * The no-code builder's check: the source the signal rules generate and the inputs they declare. A blank
     * required input refuses by name (`quant.param_unset`, `quant.sizing_rule_unset`); nothing runs and nothing is
     * stored.
     */
    compile: publicJurisdictionProcedure('quant', 'fiat')
      .input(z.object({ modules: quantSignalRulesSchema, ...accountField }))
      .output(quantCompileOutputSchema)
      .query(({ input, ctx }) => {
        try {
          accountOf(ctx, input.accountId);
          const compiled = compileSignalRules(input.modules);
          return { source: compiled.source, inputs: compiled.inputs.map((row) => ({ ...row })) };
        } catch (err) {
          toTrpc(err);
        }
      }),

    /**
     * Saved strategies for the caller's account. `limit` is optional so omit
     * reaches `quant.studio_list_limit_unset` instead of a Zod "Required".
     * Blank is not 50; pass 50 explicitly when that is the page you want.
     * A body accountId does not select another account. Deleted rows are absent.
     */
    list: publicJurisdictionProcedure('quant', 'fiat')
      .input(
        z
          .object({
            limit: z.number().int().min(1).max(STUDIO_LIST_LIMIT_CAP).optional(),
            cursor: z.string().optional().nullable(),
            ...accountField,
          })
          .optional(),
      )
      .output(z.object({ strategies: z.array(strategyHead), nextCursor: z.string().nullable() }))
      .query(async ({ input, ctx }) => {
        try {
          const accountId = accountOf(ctx, input?.accountId);
          const limit = assertStudioListLimit(input?.limit);
          const page = await strategies.list({ accountId, limit, cursor: input?.cursor });
          return { strategies: page.strategies.slice(0, limit), nextCursor: page.nextCursor };
        } catch (err) {
          toTrpc(err);
        }
      }),

    get: publicJurisdictionProcedure('quant', 'fiat')
      .input(z.object({ id: z.string().min(1), ...accountField }))
      .output(strategyDetailForLive)
      .query(async ({ input, ctx }) => {
        try {
          const found = await strategies.get({ accountId: accountOf(ctx, input.accountId), id: input.id });
          if (!found) missingStrategy();
          const [policy, rows] = await Promise.all([approvals.policy(found.accountId), approvals.approvals(found.id)]);
          return {
            ...found,
            liveApproval: { required: policy?.required === true, approvedVersions: await approvedVersionsOf(found, rows) },
          };
        } catch (err) {
          toTrpc(err);
        }
      }),

    update: publicJurisdictionProcedure('quant', 'fiat')
      .input(
        z
          .object({
            id: z.string().min(1),
            name: z.string().min(1).max(128),
            blocks: z.array(studioBlock),
            modules: quantSignalRulesSchema.optional().nullable(),
            risk: studioRisk,
            cash: decimal.optional().nullable(),
            ...accountField,
            ...writeKeyField,
            releaseNote: z.string().max(2000).optional(),
          })
          .merge(environmentInput),
      )
      .output(strategyDetail)
      .mutation(async ({ input, ctx }) => {
        try {
          const accountId = accountOf(ctx, input.accountId);
          const prior = await replayOf(accountId, input.idempotencyKey);
          if (prior?.operation === 'revise') return prior.response;
          if (prior) idempotencyConflict(prior.operation);
          const existing = await strategies.get({ accountId, id: input.id });
          if (!existing) missingStrategy();
          await refuseWhileLocked(accountId, existing.id);
          const built = buildSavedStrategy(input, input.id);
          const releaseNote = releaseNoteOf(input.releaseNote);
          return await strategies.revise({
            accountId,
            id: input.id,
            idempotencyKey: requireIdempotencyKey(input.idempotencyKey),
            draft: { ...draftOf(built), releaseNote },
          });
        } catch (err) {
          toTrpc(err);
        }
      }),

    delete: publicJurisdictionProcedure('quant', 'fiat')
      .input(z.object({ id: z.string().min(1), ...accountField, ...writeKeyField }))
      .output(z.object({ ok: z.literal(true) }))
      .mutation(async ({ input, ctx }) => {
        try {
          const accountId = accountOf(ctx, input.accountId);
          const prior = await replayOf(accountId, input.idempotencyKey);
          if (prior?.operation === 'delete') return prior.response;
          if (prior) idempotencyConflict(prior.operation);
          const existing = await strategies.get({ accountId, id: input.id });
          if (!existing) missingStrategy();
          return strategies.softDelete({
            accountId,
            id: input.id,
            idempotencyKey: requireIdempotencyKey(input.idempotencyKey),
          });
        } catch (err) {
          toTrpc(err);
        }
      }),

    /**
     * The line difference between two stored versions of one of the caller's strategies (AL-editor-01): the source,
     * the order blocks and the signal rules. Derived on read. A version the strategy does not have is not found.
     */
    diff: publicJurisdictionProcedure('quant', 'fiat')
      .input(z.object({ id: z.string().min(1), from: z.number().int().positive(), to: z.number().int().positive(), ...accountField }))
      .output(quantVersionDiffSchema)
      .query(async ({ input, ctx }) => {
        try {
          const found = await strategies.get({ accountId: accountOf(ctx, input.accountId), id: input.id });
          if (!found) missingStrategy();
          const from = found.versions.find((row) => row.version === input.from);
          const to = found.versions.find((row) => row.version === input.to);
          if (!from || !to) {
            throw new QuantError(QUANT_VERSION_NOT_FOUND, `version — ${!from ? input.from : input.to} is not a version of this strategy`);
          }
          return versionDiff(from, to);
        } catch (err) {
          toTrpc(err);
        }
      }),

    /**
     * Rename, move to a folder and describe one of the caller's strategies (AL-editor-01). The head changes and no
     * version is added. All three are sent each time; the screen keys the write `studio.organise:<id>:<organised>`.
     */
    organise: publicJurisdictionProcedure('quant', 'fiat')
      .input(
        z.object({
          id: z.string().min(1),
          name: z.unknown().optional(),
          folder: z.unknown().optional(),
          description: z.unknown().optional(),
          ...accountField,
          ...writeKeyField,
        }),
      )
      .output(strategyDetail)
      .mutation(async ({ input, ctx }) => {
        try {
          const accountId = accountOf(ctx, input.accountId);
          const prior = await replayOf(accountId, input.idempotencyKey);
          if (prior?.operation === 'organise') return prior.response;
          if (prior) idempotencyConflict(prior.operation);
          const head = organisationOf(input);
          return strategies.organise({ accountId, id: input.id, idempotencyKey: requireIdempotencyKey(input.idempotencyKey), head });
        } catch (err) {
          toTrpc(err);
        }
      }),

    /**
     * Bring a deleted strategy back from the recycle bin with the versions it had (AL-editor-01). One that is not
     * deleted returns its head unchanged. The screen keys it `studio.restore:<id>:<deletedAt>`.
     */
    restore: publicJurisdictionProcedure('quant', 'fiat')
      .input(z.object({ id: z.string().min(1), ...accountField, ...writeKeyField }))
      .output(strategyDetail)
      .mutation(async ({ input, ctx }) => {
        try {
          const accountId = accountOf(ctx, input.accountId);
          const prior = await replayOf(accountId, input.idempotencyKey);
          if (prior?.operation === 'restore') return prior.response;
          if (prior) idempotencyConflict(prior.operation);
          return await strategies.restore({ accountId, id: input.id, idempotencyKey: requireIdempotencyKey(input.idempotencyKey) });
        } catch (err) {
          toTrpc(err);
        }
      }),

    /** The recycle bin: the caller's deleted strategies, with the same page limit rule as the list. */
    listDeleted: publicJurisdictionProcedure('quant', 'fiat')
      .input(
        z
          .object({
            limit: z.number().int().min(1).max(STUDIO_LIST_LIMIT_CAP).optional(),
            cursor: z.string().optional().nullable(),
            ...accountField,
          })
          .optional(),
      )
      .output(z.object({ strategies: z.array(strategyHead), nextCursor: z.string().nullable() }))
      .query(async ({ input, ctx }) => {
        try {
          const accountId = accountOf(ctx, input?.accountId);
          const limit = assertStudioListLimit(input?.limit);
          const page = await strategies.listDeleted({ accountId, limit, cursor: input?.cursor });
          return { strategies: page.strategies.slice(0, limit), nextCursor: page.nextCursor };
        } catch (err) {
          toTrpc(err);
        }
      }),

    clone: publicJurisdictionProcedure('quant', 'fiat')
      .input(
        z
          .object({
            id: z.string().min(1).optional(),
            strategyId: z.string().min(1).optional(),
            name: z.string().min(1).max(128).optional(),
            ...accountField,
            ...writeKeyField,
            ...clientIdField,
          })
          .merge(environmentInput),
      )
      .output(strategyDetail)
      .mutation(async ({ input, ctx }) => {
        try {
          const accountId = accountOf(ctx, input.accountId);
          const prior = await replayOf(accountId, input.idempotencyKey);
          if (prior?.operation === 'create') return prior.response;
          if (prior) idempotencyConflict(prior.operation);
          const strategyId = input.strategyId?.trim() || input.id?.trim() || '';
          if (!strategyId) throw new QuantError('quant.params_invalid', 'strategyId is unset');
          const found = await strategies.get({ accountId, id: strategyId });
          if (!found) missingStrategy();
          const name = `${found.name} copy`;
          if (name.length > 128) throw new QuantError('quant.params_invalid', 'strategy name is longer than 128 characters');
          const built = buildSavedStrategy(
            {
              name,
              blocks: found.blocks,
              modules: found.modules,
              risk: found.risk,
              cash: found.cash,
              environment: input.environment ?? found.environment,
              presentedAs: input.presentedAs ?? found.environment,
            },
            'studio_pending',
          );
          return await strategies.create({
            accountId,
            clientStrategyId: requireClientStrategyId(input.clientStrategyId),
            idempotencyKey: requireIdempotencyKey(input.idempotencyKey),
            draft: draftOf(built),
          });
        } catch (err) {
          toTrpc(err);
        }
      }),

    /** Run the caller's saved source. Another account's id is not found. */
    run: publicJurisdictionProcedure('quant', 'fiat')
      .input(z.object({ id: z.string().min(1), ...accountField, ...writeKeyField }).merge(environmentInput))
      .output(runOutput)
      .mutation(async ({ input, ctx }) =>
        withQuantSpan('quant.studio.run', { language: 'javascript' }, async () => {
          try {
            const accountId = accountOf(ctx, input.accountId);
            const found = await strategies.get({ accountId, id: input.id });
            if (!found) missingStrategy();
            // Signal rules are data for the bar engine; their generated source is a view and names helpers the
            // sandbox does not have, so it is never run here.
            if (found.modules) {
              throw new QuantError(QUANT_SIGNAL_RULES_SANDBOX, 'signal rules run on bars in a backtest, not in the sandbox');
            }
            const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
            const run = await runLimitsFor(accountId);
            return await trackRun(
              runs,
              {
                userId: accountId,
                idempotencyKey,
                kind: 'sandbox',
                strategyId: found.id,
                strategyVersion: found.version,
              },
              async () =>
                runSandbox(
                  {
                    language: found.language,
                    source: found.source,
                    cash: found.cash,
                    environment: input.environment ?? found.environment,
                    presentedAs: input.presentedAs ?? found.environment,
                  },
                  runDeps(run),
                ),
              (value, err) => ({
                detail: err || !value ? null : sandboxBody(value),
                response: err ? null : value,
              }),
            );
          } catch (err) {
            toTrpc(err);
          }
        }),
      ),

    /**
     * Every account's metadata. Admin scope required. No source and no blocks.
     * A body accountId is ignored — this is not a way to read one user's source.
     */
    operatorList: publicJurisdictionProcedure('quant', 'fiat')
      .input(
        z
          .object({
            limit: z.number().int().min(1).max(STUDIO_LIST_LIMIT_CAP).optional(),
            ...accountField,
          })
          .optional(),
      )
      .output(z.object({ strategies: z.array(strategyMetadata), quarantineCount: z.number().int().nonnegative() }))
      .query(async ({ input, ctx }) => {
        try {
          requireStudioOperator(ctx);
          const limit = assertStudioListLimit(input?.limit);
          const page = await strategies.operatorList({ limit });
          return {
            strategies: page.strategies.slice(0, limit),
            quarantineCount: page.quarantineCount,
          };
        } catch (err) {
          toTrpc(err);
        }
      }),
  });
}
