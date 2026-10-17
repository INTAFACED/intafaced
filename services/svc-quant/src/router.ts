import { z } from 'zod';
import { publicJurisdictionProcedure, publicProcedure, router, TRPCError, type Context } from '@intafaced/contracts';
import type { BacktestCostModel } from '@intafaced/quant-honesty';
import { missingLake, type BacktestLake } from './backtest/lake.js';
import { runBacktest } from './backtest/run.js';
import {
  QUANT_BACKTEST_FILLS_MISSING,
  QUANT_BACKTEST_LAKE_MISSING,
  QUANT_BACKTEST_SURFACE_REFUSED,
  QUANT_BACKTEST_WALK_FORWARD_REQUIRED,
  QUANT_CASH_UNSET,
  QUANT_ENVIRONMENT_REQUIRED,
  QUANT_ENVIRONMENT_UNKNOWN,
  QUANT_SANDBOX_MAX_OPS_UNSET,
  QUANT_SANDBOX_MAX_SOURCE_UNSET,
  QUANT_SANDBOX_UNWIRED,
  QUANT_SIMULATED_AS_LIVE,
  QUANT_STUDIO_LIST_LIMIT_UNSET,
  QUANT_STUDIO_NOT_FOUND,
  QUANT_STUDIO_RISK_BLOCK_REQUIRED,
  QuantError,
} from './errors.js';
import { claimMarketplace } from './marketplace/claim.js';
import { sandboxSourceInputMax } from './sandbox/max.js';
import { runSandbox, type SandboxDeps } from './sandbox/run.js';
import { replaceStudio, saveStudio } from './studio/save.js';
import { assertStudioListLimit, STUDIO_LIST_LIMIT_CAP } from './studio/list-limit.js';
import { requireStudioOperator, resolveStudioAccount, STUDIO_SERVICE_ALLOWLIST } from './studio/scope.js';
import { createStudioStore } from './studio/store.js';
import { withQuantSpan } from './tracing.js';

const simulatedStamp = z.object({
  environment: z.enum(['paper', 'backtest', 'shadow']),
  kind: z.enum(['paper', 'simulated']),
  claimLabel: z.enum(['Paper — not live performance', 'Historical simulation — not a forecast', 'Shadow — not live performance']),
  live: z.literal(false),
  simulated: z.literal(true),
});

const environmentInput = z.object({
  environment: z.string().optional().nullable(),
  presentedAs: z.string().optional().nullable(),
});

const decimal = z.string().regex(/^-?\d+(\.\d{1,18})?$/, 'amounts are decimal strings with at most 18 decimal places');

const language = z.enum(['javascript', 'typescript', 'python']);

const fillSchema = z.object({
  side: z.enum(['buy', 'sell']),
  symbol: z.string(),
  qty: z.string(),
  price: z.string(),
  venue: z.literal('internal'),
});

const runOutput = z
  .object({
    ok: z.literal(true),
    language,
    logs: z.array(z.string()),
    cash: z.string(),
    pnl: z.string(),
    fills: z.array(fillSchema),
    positions: z.array(z.object({ symbol: z.string(), qty: z.string() })),
    venue: z.literal('internal'),
    venueVault: z.enum(['unset', 'set']),
  })
  .merge(simulatedStamp);

function toTrpc(err: unknown): never {
  if (err instanceof QuantError) {
    const code =
      err.code === QUANT_STUDIO_NOT_FOUND
        ? 'NOT_FOUND'
        : err.code === QUANT_SANDBOX_UNWIRED ||
            err.code === QUANT_SANDBOX_MAX_OPS_UNSET ||
            err.code === QUANT_SANDBOX_MAX_SOURCE_UNSET ||
            err.code === QUANT_BACKTEST_LAKE_MISSING ||
            err.code === QUANT_BACKTEST_FILLS_MISSING ||
            err.code === QUANT_STUDIO_LIST_LIMIT_UNSET ||
            err.code === 'quant.venue_vault_unset'
          ? 'PRECONDITION_FAILED'
          : err.code === QUANT_STUDIO_RISK_BLOCK_REQUIRED ||
              err.code === QUANT_BACKTEST_WALK_FORWARD_REQUIRED ||
              err.code === QUANT_BACKTEST_SURFACE_REFUSED ||
              err.code === QUANT_ENVIRONMENT_REQUIRED ||
              err.code === QUANT_ENVIRONMENT_UNKNOWN ||
              err.code === QUANT_SIMULATED_AS_LIVE ||
              err.code === QUANT_CASH_UNSET
            ? 'BAD_REQUEST'
            : err.code === 'quant.sandbox_timeout'
              ? 'TIMEOUT'
              : 'BAD_REQUEST';
    throw new TRPCError({ code, message: err.message, cause: err });
  }
  throw err;
}

const studioBlock = z.object({
  side: z.enum(['buy', 'sell']),
  symbol: z.string().min(1).max(32),
  qty: decimal,
});

const studioRisk = z
  .object({
    maxDrawdown: z.string().optional(),
    maxNotional: z.string().optional(),
    kill: z.string().optional(),
  })
  .optional();

const savedStrategy = z
  .object({
    id: z.string(),
    name: z.string(),
    language: z.literal('javascript'),
    source: z.string(),
    cash: z.string(),
    blocks: z.array(studioBlock),
    risk: z.object({
      maxDrawdown: z.string(),
      maxNotional: z.string(),
      kill: z.string(),
    }),
  })
  .merge(simulatedStamp);

const costEvidence = z.object({
  kind: z.string(),
  source: z.string(),
});

const backtestOutput = z
  .object({
    ok: z.literal(true),
    runId: z.string(),
    strategyId: z.string(),
    walkForward: z.object({
      inSampleFrom: z.string(),
      inSampleTo: z.string(),
      outOfSampleFrom: z.string(),
      outOfSampleTo: z.string(),
    }),
    inSample: z.object({ fillCount: z.number().int(), notional: decimal }),
    outOfSample: z.object({ fillCount: z.number().int(), notional: decimal }),
    claimLabel: z.literal('Historical simulation — not a forecast'),
    outOfSampleLabel: z.string(),
  })
  .merge(simulatedStamp);

export interface QuantRouterDeps extends SandboxDeps {
  readonly lake?: BacktestLake;
  /**
   * Services allowed to name an account. Defaults to none.
   * `src/index.ts` does not set this.
   */
  readonly studioServiceAllowlist?: readonly string[];
}

const strategyMetadata = z.object({
  id: z.string(),
  accountId: z.string().uuid().nullable(),
  name: z.string(),
  language: z.literal('javascript'),
  environment: z.enum(['paper', 'backtest', 'shadow']),
  kind: z.enum(['paper', 'simulated']),
  claimLabel: z.enum(['Paper — not live performance', 'Historical simulation — not a forecast', 'Shadow — not live performance']),
  live: z.literal(false),
  simulated: z.literal(true),
});

const accountField = { accountId: z.string().uuid().optional() };

export function createQuantRouter(deps: QuantRouterDeps) {
  const studio = createStudioStore();
  const lake = deps.lake ?? missingLake();
  const studioServices = new Set(deps.studioServiceAllowlist ?? STUDIO_SERVICE_ALLOWLIST);

  function accountOf(ctx: Context, bodyAccountId: string | undefined): string {
    return resolveStudioAccount(ctx, bodyAccountId, studioServices);
  }

  function missingStrategy(): never {
    throw new QuantError(QUANT_STUDIO_NOT_FOUND, 'strategy not found');
  }
  return router({
    health: publicProcedure
      .output(z.object({ ok: z.literal(true), service: z.literal('svc-quant') }))
      .query(() => ({ ok: true as const, service: 'svc-quant' as const })),

    studio: router({
      save: publicJurisdictionProcedure('quant', 'fiat')
        .input(
          z
            .object({
              name: z.string().min(1).max(128),
              blocks: z.array(studioBlock).min(1),
              risk: studioRisk,
              cash: decimal.optional().nullable(),
              ...accountField,
            })
            .merge(environmentInput),
        )
        .output(savedStrategy)
        .mutation(async ({ input, ctx }) =>
          withQuantSpan('quant.studio.save', { language: 'javascript' }, async () => {
            try {
              return saveStudio(input, studio, accountOf(ctx, input.accountId));
            } catch (err) {
              toTrpc(err);
            }
          }),
        ),

      /**
       * Saved strategies for the caller's account. `limit` is optional so omit
       * reaches `quant.studio_list_limit_unset` instead of a Zod "Required".
       * Blank is not 50; pass 50 explicitly when that is the page you want.
       * A body accountId does not select another account.
       */
      list: publicJurisdictionProcedure('quant', 'fiat')
        .input(
          z
            .object({
              limit: z.number().int().min(1).max(STUDIO_LIST_LIMIT_CAP).optional(),
              ...accountField,
            })
            .optional(),
        )
        .output(z.object({ strategies: z.array(savedStrategy) }))
        .query(({ input, ctx }) => {
          try {
            const accountId = accountOf(ctx, input?.accountId);
            const limit = assertStudioListLimit(input?.limit);
            return { strategies: studio.list(accountId).slice(0, limit) };
          } catch (err) {
            toTrpc(err);
          }
        }),

      get: publicJurisdictionProcedure('quant', 'fiat')
        .input(z.object({ id: z.string().min(1), ...accountField }))
        .output(savedStrategy)
        .query(({ input, ctx }) => {
          try {
            const found = studio.get(accountOf(ctx, input.accountId), input.id);
            if (!found) missingStrategy();
            return found;
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
              blocks: z.array(studioBlock).min(1),
              risk: studioRisk,
              cash: decimal.optional().nullable(),
              ...accountField,
            })
            .merge(environmentInput),
        )
        .output(savedStrategy)
        .mutation(async ({ input, ctx }) => {
          try {
            return replaceStudio(input, studio, accountOf(ctx, input.accountId), input.id);
          } catch (err) {
            toTrpc(err);
          }
        }),

      delete: publicJurisdictionProcedure('quant', 'fiat')
        .input(z.object({ id: z.string().min(1), ...accountField }))
        .output(z.object({ ok: z.literal(true) }))
        .mutation(async ({ input, ctx }) => {
          try {
            if (!studio.remove(accountOf(ctx, input.accountId), input.id)) missingStrategy();
            return { ok: true as const };
          } catch (err) {
            toTrpc(err);
          }
        }),

      clone: publicJurisdictionProcedure('quant', 'fiat')
        .input(
          z
            .object({
              id: z.string().min(1),
              name: z.string().min(1).max(128).optional(),
              ...accountField,
            })
            .merge(environmentInput),
        )
        .output(savedStrategy)
        .mutation(async ({ input, ctx }) => {
          try {
            const accountId = accountOf(ctx, input.accountId);
            const found = studio.get(accountId, input.id);
            if (!found) missingStrategy();
            return saveStudio(
              {
                name: input.name ?? found.name,
                blocks: found.blocks,
                risk: found.risk,
                cash: found.cash,
                environment: input.environment ?? found.environment,
                presentedAs: input.presentedAs ?? found.environment,
              },
              studio,
              accountId,
            );
          } catch (err) {
            toTrpc(err);
          }
        }),

      /** Run the caller's saved source. Another account's id is not found. */
      run: publicJurisdictionProcedure('quant', 'fiat')
        .input(z.object({ id: z.string().min(1), ...accountField }).merge(environmentInput))
        .output(runOutput)
        .mutation(async ({ input, ctx }) =>
          withQuantSpan('quant.studio.run', { language: 'javascript' }, async () => {
            try {
              const found = studio.get(accountOf(ctx, input.accountId), input.id);
              if (!found) missingStrategy();
              return runSandbox(
                {
                  language: found.language,
                  source: found.source,
                  cash: found.cash,
                  environment: input.environment ?? found.environment,
                  presentedAs: input.presentedAs ?? found.environment,
                },
                deps,
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
        .query(({ input, ctx }) => {
          try {
            requireStudioOperator(ctx);
            const limit = assertStudioListLimit(input?.limit);
            return {
              strategies: studio.listMetadata().slice(0, limit),
              quarantineCount: studio.quarantineCount(),
            };
          } catch (err) {
            toTrpc(err);
          }
        }),
    }),

    backtest: router({
      run: publicJurisdictionProcedure('quant', 'fiat')
        .input(
          z
            .object({
              strategyId: z.string(),
              symbol: z.string(),
              walkForward: z
                .object({
                  inSampleFrom: z.string().optional(),
                  inSampleTo: z.string().optional(),
                  outOfSampleFrom: z.string().optional(),
                  outOfSampleTo: z.string().optional(),
                })
                .optional()
                .nullable(),
              outOfSampleStatus: z.enum(['passed', 'failed', 'inconclusive']).optional().nullable(),
              costModel: z
                .object({
                  fees: costEvidence.optional().nullable(),
                  slippage: costEvidence.optional().nullable(),
                  latency: costEvidence.optional().nullable(),
                })
                .optional()
                .nullable(),
              strategyVariantCount: z.number().int().optional(),
            })
            .merge(environmentInput),
        )
        .output(backtestOutput)
        .mutation(async ({ input }) =>
          withQuantSpan('quant.backtest.run', { language: 'fills' }, async () => {
            try {
              return runBacktest(
                {
                  strategyId: input.strategyId,
                  symbol: input.symbol,
                  walkForward: input.walkForward,
                  outOfSampleStatus: input.outOfSampleStatus,
                  costModel: input.costModel as BacktestCostModel | null | undefined,
                  strategyVariantCount: input.strategyVariantCount,
                  environment: input.environment,
                  presentedAs: input.presentedAs,
                },
                lake,
              );
            } catch (err) {
              toTrpc(err);
            }
          }),
        ),
    }),

    sandbox: router({
      capabilities: publicJurisdictionProcedure('quant', 'fiat').query(() => ({
        isolate: deps.wired ? ('wired' as const) : ('unwired' as const),
        languages: ['javascript', 'typescript', 'python'] as const,
        venueVault: deps.venueVaultSet ? ('trade-only' as const) : ('unset' as const),
        refuse: deps.wired ? null : QUANT_SANDBOX_UNWIRED,
      })),

      run: publicJurisdictionProcedure('quant', 'fiat')
        .input(
          z
            .object({
              language,
              source: z.string().min(1).max(sandboxSourceInputMax(deps.limits.maxSource)),
              cash: decimal.optional().nullable(),
            })
            .merge(environmentInput),
        )
        .output(runOutput)
        .mutation(async ({ input }) =>
          withQuantSpan('quant.sandbox.run', { language: input.language }, async () => {
            try {
              return runSandbox(input, deps);
            } catch (err) {
              toTrpc(err);
            }
          }),
        ),
    }),

    marketplace: router({
      claim: publicJurisdictionProcedure('quant', 'fiat')
        .input(
          z
            .object({
              strategyId: z.string().min(1),
              pnl: decimal.optional(),
            })
            .merge(environmentInput),
        )
        .output(
          simulatedStamp.extend({
            ok: z.literal(true),
            strategyId: z.string(),
            pnl: decimal.optional(),
          }),
        )
        .mutation(async ({ input }) =>
          withQuantSpan('quant.marketplace.claim', { language: 'claim' }, async () => {
            try {
              return claimMarketplace(input);
            } catch (err) {
              toTrpc(err);
            }
          }),
        ),
    }),
  });
}

export type QuantRouter = ReturnType<typeof createQuantRouter>;
