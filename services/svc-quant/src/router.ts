import { z } from 'zod';
import {
  publicJurisdictionProcedure,
  publicProcedure,
  quantDisclosureAcceptInputSchema,
  quantDisclosureAcceptKey,
  quantDisclosureAcceptOutputSchema,
  quantDisclosureCountsOutputSchema,
  quantDisclosureCurrentSchema,
  quantDisclosurePublishInputSchema,
  quantDisclosurePublishOutputSchema,
  quantDisclosureStatusInputSchema,
  quantDisclosureStatusOutputSchema,
  quantCompileOutputSchema,
  quantQuickStartOutputSchema,
  quantSignalRulesSchema,
  quantTemplateDetailSchema,
  quantTemplateIdSchema,
  quantTemplateListOutputSchema,
  quantTemplatePublishInputSchema,
  quantTemplateVersionSchema,
  router,
  scopedProcedure,
  TRPCError,
  type Context,
} from '@intafaced/contracts';
import type { BacktestCostModel } from '@intafaced/quant-honesty';
import { missingLake, type BacktestLake } from './backtest/lake.js';
import { backtestBodyOf, runBacktest } from './backtest/run.js';
import {
  QUANT_BACKTEST_FILLS_MISSING,
  QUANT_BACKTEST_LAKE_MISSING,
  QUANT_BACKTEST_SURFACE_REFUSED,
  QUANT_BACKTEST_WALK_FORWARD_REQUIRED,
  QUANT_CASH_UNSET,
  QUANT_CLAIM_PNL_UNSET,
  QUANT_CLIENT_STRATEGY_ID_UNSET,
  QUANT_DATABASE_POOL_MAX_UNSET,
  QUANT_DATABASE_URL_UNSET,
  QUANT_DISCLOSURE_UNSET,
  QUANT_SIGNAL_RULES_SANDBOX,
  QUANT_TEMPLATE_LIST_LIMIT_UNSET,
  QUANT_TEMPLATE_NOT_FOUND,
  QUANT_DISCLOSURE_VERSION_STALE,
  QUANT_ENVIRONMENT_REQUIRED,
  QUANT_ENVIRONMENT_UNKNOWN,
  QUANT_IDEMPOTENCY_CONFLICT,
  QUANT_IDEMPOTENCY_KEY_UNSET,
  QUANT_LIST_CURSOR_INVALID,
  QUANT_OPS_RUNS_FROM_UNSET,
  QUANT_OPS_RUNS_LIMIT_UNSET,
  QUANT_OPS_RUNS_TO_UNSET,
  QUANT_RUN_NOT_FOUND,
  QUANT_RUN_NOT_SIMULATED,
  QUANT_RUN_RESULT_CAP_UNSET,
  QUANT_RUN_RESULT_TOO_LARGE,
  QUANT_RUN_UNFINISHED,
  QUANT_SANDBOX_MAX_OPS_UNSET,
  QUANT_SANDBOX_MAX_SOURCE_UNSET,
  QUANT_SANDBOX_UNWIRED,
  QUANT_SIMULATED_AS_LIVE,
  QUANT_STRATEGY_VERSION_UNSET,
  QUANT_STUDIO_LIST_LIMIT_UNSET,
  QUANT_STUDIO_NOT_FOUND,
  QUANT_STUDIO_RISK_BLOCK_REQUIRED,
  QuantError,
} from './errors.js';
import type { DisclosureRepository } from './disclosure/repository.js';
import { openDisclosureRepository } from './disclosure/open.js';
import type { TemplateRepository } from './templates/repository.js';
import { openTemplateRepository } from './templates/open.js';
import { blankTemplateRules } from './templates/rules.js';
import { requireSimulatedStamp } from './honesty.js';
import { claimFromRun } from './marketplace/claim.js';
import { assertOpsRunsLimit, optionalWindowBound, requireWindowBound, RUN_RESULT_MAX_BYTES } from './runs/limit.js';
import { createMemoryRunRepository } from './runs/memory-repository.js';
import type { RunRepository } from './runs/repository.js';
import { trackRun } from './runs/track.js';
import type { RunResultBody } from './runs/types.js';
import { sandboxSourceInputMax } from './sandbox/max.js';
import { runSandbox, type SandboxDeps } from './sandbox/run.js';
import { compileSignalRules } from './studio/modules.js';
import { buildSavedStrategy } from './studio/save.js';
import { assertStudioListLimit, STUDIO_LIST_LIMIT_CAP } from './studio/list-limit.js';
import { idempotencyConflict, requireClientStrategyId, requireIdempotencyKey } from './studio/keys.js';
import { openStrategyRepository } from './studio/open.js';
import { draftOf, type StrategyRepository, type WriteReceipt } from './studio/repository.js';
import { requireStudioOperator, resolveStudioAccount, STUDIO_SERVICE_ALLOWLIST } from './studio/scope.js';
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
      err.code === QUANT_STUDIO_NOT_FOUND || err.code === QUANT_RUN_NOT_FOUND || err.code === QUANT_TEMPLATE_NOT_FOUND
        ? 'NOT_FOUND'
        : err.code === QUANT_SANDBOX_UNWIRED ||
            err.code === QUANT_SANDBOX_MAX_OPS_UNSET ||
            err.code === QUANT_SANDBOX_MAX_SOURCE_UNSET ||
            err.code === QUANT_BACKTEST_LAKE_MISSING ||
            err.code === QUANT_BACKTEST_FILLS_MISSING ||
            err.code === QUANT_STUDIO_LIST_LIMIT_UNSET ||
            err.code === QUANT_TEMPLATE_LIST_LIMIT_UNSET ||
            err.code === QUANT_RUN_UNFINISHED ||
            err.code === QUANT_RUN_NOT_SIMULATED ||
            err.code === QUANT_RUN_RESULT_CAP_UNSET ||
            err.code === QUANT_RUN_RESULT_TOO_LARGE ||
            err.code === QUANT_CLAIM_PNL_UNSET ||
            err.code === QUANT_DISCLOSURE_UNSET ||
            err.code === QUANT_SIGNAL_RULES_SANDBOX ||
            err.code === 'quant.venue_vault_unset'
          ? 'PRECONDITION_FAILED'
          : err.code === QUANT_DATABASE_URL_UNSET || err.code === QUANT_DATABASE_POOL_MAX_UNSET
            ? 'PRECONDITION_FAILED'
            : err.code === QUANT_STUDIO_RISK_BLOCK_REQUIRED ||
                err.code === QUANT_BACKTEST_WALK_FORWARD_REQUIRED ||
                err.code === QUANT_BACKTEST_SURFACE_REFUSED ||
                err.code === QUANT_ENVIRONMENT_REQUIRED ||
                err.code === QUANT_ENVIRONMENT_UNKNOWN ||
                err.code === QUANT_SIMULATED_AS_LIVE ||
                err.code === QUANT_CASH_UNSET ||
                err.code === QUANT_CLIENT_STRATEGY_ID_UNSET ||
                err.code === QUANT_IDEMPOTENCY_KEY_UNSET ||
                err.code === QUANT_IDEMPOTENCY_CONFLICT ||
                err.code === QUANT_STRATEGY_VERSION_UNSET ||
                err.code === QUANT_LIST_CURSOR_INVALID ||
                err.code === QUANT_OPS_RUNS_LIMIT_UNSET ||
                err.code === QUANT_OPS_RUNS_FROM_UNSET ||
                err.code === QUANT_OPS_RUNS_TO_UNSET
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

const strategyVersionRecord = z
  .object({
    version: z.number().int().positive(),
    createdAt: z.string(),
    name: z.string(),
    language: z.literal('javascript'),
    source: z.string(),
    cash: z.string(),
    blocks: z.array(studioBlock),
    modules: quantSignalRulesSchema.nullable(),
    risk: z.object({
      maxDrawdown: z.string(),
      maxNotional: z.string(),
      kill: z.string(),
    }),
  })
  .merge(simulatedStamp);

const strategyHead = strategyVersionRecord.extend({
  id: z.string(),
  accountId: z.string().uuid(),
  clientStrategyId: z.string(),
  deletedAt: z.string().nullable(),
});

const strategyDetail = strategyHead.extend({
  versions: z.array(strategyVersionRecord),
});

const costEvidence = z.object({
  kind: z.string(),
  source: z.string(),
});

const costBreakdown = z
  .object({
    fees: costEvidence.nullable(),
    slippage: costEvidence.nullable(),
    latency: costEvidence.nullable(),
  })
  .nullable();

const runDetailOutput = z.object({
  runId: z.string(),
  kind: z.enum(['backtest', 'sandbox']),
  strategyId: z.string().nullable(),
  strategyVersion: z.number().int().positive().nullable(),
  started: z.string(),
  finished: z.string().nullable(),
  outcome: z.string().nullable(),
  equityCurve: z.array(z.object({ ts: z.string(), equity: decimal })).nullable(),
  trades: z.array(z.object({ ts: z.string(), symbol: z.string(), qty: decimal, price: decimal })).nullable(),
  costs: costBreakdown,
  pnl: decimal.nullable(),
});

function sandboxBody(ran: {
  pnl: string;
  environment: RunResultBody['environment'];
  kind: RunResultBody['kind'];
  claimLabel: RunResultBody['claimLabel'];
}): RunResultBody {
  return {
    equityCurve: null,
    trades: null,
    costs: null,
    pnl: ran.pnl,
    simulated: true,
    live: false,
    environment: ran.environment,
    kind: ran.kind,
    claimLabel: ran.claimLabel,
  };
}

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
    strategyVersion: z.number().int().positive(),
  })
  .merge(simulatedStamp);

export interface QuantRouterDeps extends SandboxDeps {
  readonly lake?: BacktestLake;
  /**
   * Services allowed to name an account. Defaults to none.
   * `src/index.ts` does not set this.
   */
  readonly studioServiceAllowlist?: readonly string[];
  /** Omitted only when DATABASE_URL is unset: studio and backtest then refuse by name. */
  readonly strategies?: StrategyRepository;
  /** Omitted in tests: an in-memory run log. Production passes Postgres. */
  readonly runs?: RunRepository;
  /** Omitted refuses by naming the missing database. Production passes Postgres. */
  readonly disclosure?: DisclosureRepository;
  /** Omitted refuses by naming the missing database. Production passes Postgres. */
  readonly templates?: TemplateRepository;
  /** Omitted uses the published byte cap. Pass null only to prove the cap refuses. */
  readonly runResultCap?: number | null;
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
const writeKeyField = { idempotencyKey: z.string().optional().nullable() };
const clientIdField = { clientStrategyId: z.string().optional().nullable() };

export function createQuantRouter(deps: QuantRouterDeps) {
  const strategies = deps.strategies ?? openStrategyRepository({}).repository;
  const runs = deps.runs ?? createMemoryRunRepository('runResultCap' in deps ? deps.runResultCap : RUN_RESULT_MAX_BYTES);
  const lake = deps.lake ?? missingLake();
  const disclosure = deps.disclosure ?? openDisclosureRepository({}).repository;
  const templates = deps.templates ?? openTemplateRepository({}).repository;
  const studioServices = new Set(deps.studioServiceAllowlist ?? STUDIO_SERVICE_ALLOWLIST);

  async function replayOf(accountId: string, idempotencyKey: string | null | undefined): Promise<WriteReceipt | null> {
    const key = idempotencyKey?.trim() ?? '';
    if (!key) return null;
    return strategies.replay(accountId, key);
  }

  function accountOf(ctx: Context, bodyAccountId: string | undefined): string {
    return resolveStudioAccount(ctx, bodyAccountId, studioServices);
  }

  function missingStrategy(): never {
    throw new QuantError(QUANT_STUDIO_NOT_FOUND, 'strategy not found');
  }

  async function currentDisclosure() {
    const found = await disclosure.current();
    return found
      ? { published: true as const, version: found.version, text: found.text, publishedAt: found.publishedAt }
      : { published: false as const };
  }

  /** The caller's own, undeleted strategy at a version that exists. Anything else reads as not found. */
  async function ownedStrategyVersion(accountId: string, strategyId: string, strategyVersion: number): Promise<void> {
    const found = await strategies.get({ accountId, id: strategyId });
    if (!found || found.deletedAt || !found.versions.some((row) => row.version === strategyVersion)) missingStrategy();
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
              blocks: z.array(studioBlock),
              modules: quantSignalRulesSchema.optional().nullable(),
              risk: studioRisk,
              cash: decimal.optional().nullable(),
              ...accountField,
              ...writeKeyField,
              ...clientIdField,
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
              return strategies.create({
                accountId,
                clientStrategyId: requireClientStrategyId(input.clientStrategyId),
                idempotencyKey: requireIdempotencyKey(input.idempotencyKey),
                draft: draftOf(built),
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
        .output(strategyDetail)
        .query(async ({ input, ctx }) => {
          try {
            const found = await strategies.get({ accountId: accountOf(ctx, input.accountId), id: input.id });
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
              blocks: z.array(studioBlock),
              modules: quantSignalRulesSchema.optional().nullable(),
              risk: studioRisk,
              cash: decimal.optional().nullable(),
              ...accountField,
              ...writeKeyField,
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
            const built = buildSavedStrategy(input, input.id);
            return strategies.revise({
              accountId,
              id: input.id,
              idempotencyKey: requireIdempotencyKey(input.idempotencyKey),
              draft: draftOf(built),
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
            return strategies.create({
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
                    deps,
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
    }),

    /**
     * The quick start on the Algo dev home: each step is ticked only from this account's own stored rows, never a
     * fake progress. A paper run is a finished sandbox run (the sandbox is the paper book).
     */
    quickStart: publicJurisdictionProcedure('quant', 'fiat')
      .input(z.object({ ...accountField }).optional())
      .output(quantQuickStartOutputSchema)
      .query(async ({ input, ctx }) => {
        try {
          const accountId = accountOf(ctx, input?.accountId);
          const [saved, ran] = await Promise.all([
            strategies.list({ accountId, limit: 1, cursor: null }),
            runs.okKinds({ userId: accountId }),
          ]);
          return { strategy: saved.strategies.length > 0, backtest: ran.backtest, paperRun: ran.sandbox };
        } catch (err) {
          toTrpc(err);
        }
      }),

    backtest: router({
      run: publicJurisdictionProcedure('quant', 'fiat')
        .input(
          z
            .object({
              strategyId: z.string(),
              strategyVersion: z.number().int().positive().optional().nullable(),
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
              ...accountField,
              ...writeKeyField,
            })
            .merge(environmentInput),
        )
        .output(backtestOutput)
        .mutation(async ({ input, ctx }) =>
          withQuantSpan('quant.backtest.run', { language: 'fills' }, async () => {
            try {
              const accountId = accountOf(ctx, input.accountId);
              const prior = await replayOf(accountId, input.idempotencyKey);
              if (prior?.operation === 'backtest') return prior.response;
              if (prior) idempotencyConflict(prior.operation);
              const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
              const found = await strategies.get({ accountId, id: input.strategyId });
              const resolved =
                found == null
                  ? null
                  : input.strategyVersion == null
                    ? found.version
                    : (found.versions.find((row) => row.version === input.strategyVersion)?.version ?? null);
              let recorded: RunResultBody | null = null;
              return await trackRun(
                runs,
                {
                  userId: accountId,
                  idempotencyKey,
                  kind: 'backtest',
                  strategyId: input.strategyId,
                  strategyVersion: resolved ?? input.strategyVersion ?? null,
                },
                async () => {
                  if (!found || resolved == null) missingStrategy();
                  const ran = runBacktest(
                    {
                      strategyId: found.id,
                      strategyVersion: resolved,
                      symbol: input.symbol,
                      walkForward: input.walkForward,
                      outOfSampleStatus: input.outOfSampleStatus,
                      costModel: input.costModel as BacktestCostModel | null | undefined,
                      strategyVariantCount: input.strategyVariantCount,
                      environment: input.environment,
                      presentedAs: input.presentedAs,
                      cash: found.cash,
                    },
                    lake,
                  );
                  recorded = backtestBodyOf(ran);
                  return strategies.saveBacktest({
                    accountId,
                    idempotencyKey,
                    strategyId: found.id,
                    strategyVersion: resolved,
                    symbol: input.symbol,
                    result: ran,
                  });
                },
                (_value, err) => ({
                  detail: err && typeof err === 'object' ? (backtestBodyOf(err) ?? recorded) : recorded,
                  response: err ? null : _value,
                }),
              );
            } catch (err) {
              toTrpc(err);
            }
          }),
        ),

      get: publicJurisdictionProcedure('quant', 'fiat')
        .input(z.object({ runId: z.string().min(1), ...accountField }))
        .output(runDetailOutput)
        .query(async ({ input, ctx }) => {
          try {
            const userId = accountOf(ctx, input.accountId);
            const row = await runs.get({ userId, id: input.runId });
            if (!row) throw new QuantError(QUANT_RUN_NOT_FOUND, 'run not found');
            return {
              runId: row.id,
              kind: row.kind,
              strategyId: row.strategyId,
              strategyVersion: row.strategyVersion,
              started: row.started,
              finished: row.finished,
              outcome: row.outcome,
              equityCurve: row.detail?.equityCurve?.map((point) => ({ ts: point.ts, equity: point.equity })) ?? null,
              trades:
                row.detail?.trades?.map((trade) => ({ ts: trade.ts, symbol: trade.symbol, qty: trade.qty, price: trade.price })) ?? null,
              costs: row.detail?.costs
                ? {
                    fees: row.detail.costs.fees ? { kind: row.detail.costs.fees.kind, source: row.detail.costs.fees.source } : null,
                    slippage: row.detail.costs.slippage
                      ? { kind: row.detail.costs.slippage.kind, source: row.detail.costs.slippage.source }
                      : null,
                    latency: row.detail.costs.latency
                      ? { kind: row.detail.costs.latency.kind, source: row.detail.costs.latency.source }
                      : null,
                  }
                : null,
              pnl: row.detail?.pnl ?? null,
            };
          } catch (err) {
            toTrpc(err);
          }
        }),
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
              ...writeKeyField,
            })
            .merge(environmentInput),
        )
        .output(runOutput)
        .mutation(async ({ input, ctx }) =>
          withQuantSpan('quant.sandbox.run', { language: input.language }, async () => {
            try {
              const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
              const userId = ctx.principal ? (ctx.principal.sub_account ?? ctx.principal.userId) : null;
              return await trackRun(
                runs,
                {
                  userId,
                  idempotencyKey,
                  kind: 'sandbox',
                  strategyId: null,
                  strategyVersion: null,
                },
                async () => runSandbox(input, deps),
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
    }),

    marketplace: router({
      claim: publicJurisdictionProcedure('quant', 'fiat')
        .input(
          z
            .object({
              runId: z.string().min(1),
              ...writeKeyField,
            })
            .merge(environmentInput)
            .strict(),
        )
        .output(
          simulatedStamp.extend({
            ok: z.literal(true),
            runId: z.string(),
            pnl: decimal,
          }),
        )
        .mutation(async ({ input, ctx }) =>
          withQuantSpan('quant.marketplace.claim', { language: 'claim' }, async () => {
            try {
              if (
                (input.environment != null && input.environment.trim() !== '') ||
                (input.presentedAs != null && input.presentedAs.trim() !== '')
              ) {
                requireSimulatedStamp(
                  input.environment != null && input.environment.trim() !== '' ? input.environment : 'paper',
                  input.presentedAs,
                );
              }
              const userId = accountOf(ctx, undefined);
              const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
              const run = await runs.get({ userId, id: input.runId });
              const claimed = claimFromRun({
                run,
                callerId: userId,
                environment: input.environment,
                presentedAs: input.presentedAs,
              });
              const row = await runs.claimOnce({
                id: `clm_${crypto.randomUUID()}`,
                runId: claimed.runId,
                userId,
                idempotencyKey,
                pnl: claimed.pnl,
                environment: claimed.environment,
                kind: claimed.kind,
                claimLabel: claimed.claimLabel,
              });
              return {
                ok: true as const,
                runId: row.runId,
                pnl: row.pnl,
                environment: row.environment,
                kind: row.kind,
                claimLabel: row.claimLabel,
                live: false as const,
                simulated: true as const,
              };
            } catch (err) {
              toTrpc(err);
            }
          }),
        ),
    }),

    /** First-party starter templates. Read by any signed-in person; only an operator publishes. */
    template: router({
      list: publicJurisdictionProcedure('quant', 'fiat')
        .input(
          z
            .object({
              limit: z.number().int().min(1).max(STUDIO_LIST_LIMIT_CAP).optional(),
              cursor: quantTemplateIdSchema.optional().nullable(),
              ...accountField,
            })
            .optional(),
        )
        .output(quantTemplateListOutputSchema)
        .query(async ({ input, ctx }) => {
          try {
            accountOf(ctx, input?.accountId);
            if (input?.limit === undefined)
              throw new QuantError(QUANT_TEMPLATE_LIST_LIMIT_UNSET, 'pass limit; a page size is never invented');
            const page = await templates.list({ limit: input.limit, cursor: input.cursor ?? null });
            return { templates: page.templates.map((row) => ({ ...row })), nextCursor: page.nextCursor };
          } catch (err) {
            toTrpc(err);
          }
        }),

      get: publicJurisdictionProcedure('quant', 'fiat')
        .input(z.object({ id: quantTemplateIdSchema, ...accountField }))
        .output(quantTemplateDetailSchema)
        .query(async ({ input, ctx }) => {
          try {
            accountOf(ctx, input.accountId);
            const versions = await templates.get(input.id);
            if (!versions) throw new QuantError(QUANT_TEMPLATE_NOT_FOUND, 'template not found');
            return { id: input.id, versions: versions.map((row) => ({ ...row })) };
          } catch (err) {
            toTrpc(err);
          }
        }),
    }),

    disclosure: router({
      current: publicJurisdictionProcedure('quant', 'fiat')
        .output(quantDisclosureCurrentSchema)
        .query(async ({ ctx }) => {
          try {
            accountOf(ctx, undefined);
            return await currentDisclosure();
          } catch (err) {
            toTrpc(err);
          }
        }),

      status: publicJurisdictionProcedure('quant', 'fiat')
        .input(quantDisclosureStatusInputSchema)
        .output(quantDisclosureStatusOutputSchema)
        .query(async ({ input, ctx }) => {
          try {
            const accountId = accountOf(ctx, undefined);
            await ownedStrategyVersion(accountId, input.strategyId, input.strategyVersion);
            const current = await currentDisclosure();
            const found = current.published
              ? await disclosure.acceptance({
                  accountId,
                  strategyId: input.strategyId,
                  strategyVersion: input.strategyVersion,
                  disclosureVersion: current.version,
                })
              : null;
            return {
              strategyId: input.strategyId,
              strategyVersion: input.strategyVersion,
              disclosure: current,
              accepted: found !== null,
              acceptedAt: found?.acceptedAt ?? null,
            };
          } catch (err) {
            toTrpc(err);
          }
        }),

      accept: publicJurisdictionProcedure('quant', 'fiat')
        .input(quantDisclosureAcceptInputSchema)
        .output(quantDisclosureAcceptOutputSchema)
        .mutation(async ({ input, ctx }) =>
          withQuantSpan('quant.disclosure.accept', { language: 'none' }, async () => {
            try {
              const accountId = accountOf(ctx, undefined);
              await ownedStrategyVersion(accountId, input.strategyId, input.strategyVersion);
              const current = await currentDisclosure();
              if (!current.published) {
                throw new QuantError(QUANT_DISCLOSURE_UNSET, 'no risk disclosure is published');
              }
              if (current.version !== input.disclosureVersion) {
                throw new QuantError(QUANT_DISCLOSURE_VERSION_STALE, 'the disclosure changed; read it again before accepting');
              }
              const stored = await disclosure.accept({
                accountId,
                strategyId: input.strategyId,
                strategyVersion: input.strategyVersion,
                disclosureVersion: input.disclosureVersion,
                key: quantDisclosureAcceptKey(input.strategyId, input.strategyVersion, input.disclosureVersion),
              });
              return {
                strategyId: stored.strategyId,
                strategyVersion: stored.strategyVersion,
                disclosureVersion: stored.disclosureVersion,
                acceptedAt: stored.acceptedAt,
                key: stored.key,
              };
            } catch (err) {
              toTrpc(err);
            }
          }),
        ),
    }),

    ops: router({
      runs: scopedProcedure('admin:read', { module: 'quant', plane: 'fiat' })
        .input(
          z
            .object({
              from: z.string().optional().nullable(),
              to: z.string().optional().nullable(),
              kind: z.enum(['backtest', 'sandbox']).optional().nullable(),
              userId: z.string().uuid().optional().nullable(),
              limit: z.number().int().optional(),
              cursor: z.string().optional().nullable(),
            })
            .optional(),
        )
        .output(
          z.object({
            runs: z.array(
              z.object({
                id: z.string(),
                kind: z.enum(['backtest', 'sandbox']),
                userId: z.string().uuid().nullable(),
                started: z.string(),
                duration: z.number().int().nullable(),
                outcome: z.string().nullable(),
              }),
            ),
            nextCursor: z.string().nullable(),
          }),
        )
        .query(async ({ input }) => {
          try {
            const limit = assertOpsRunsLimit(input?.limit);
            const cursor = input?.cursor?.trim() ? input.cursor.trim() : null;
            const page = await runs.list({
              from: optionalWindowBound(input?.from, 'from'),
              to: optionalWindowBound(input?.to, 'to'),
              kind: input?.kind ?? null,
              userId: input?.userId ?? null,
              limit,
              cursor,
            });
            return {
              runs: page.runs.map((row) => ({
                id: row.id,
                kind: row.kind,
                userId: row.userId,
                started: row.started,
                duration: row.duration,
                outcome: row.outcome,
              })),
              nextCursor: page.nextCursor,
            };
          } catch (err) {
            toTrpc(err);
          }
        }),

      runCounts: scopedProcedure('admin:read', { module: 'quant', plane: 'fiat' })
        .input(
          z
            .object({
              from: z.string().optional().nullable(),
              to: z.string().optional().nullable(),
            })
            .optional(),
        )
        .output(
          z.object({
            byKind: z.object({ backtest: z.number().int(), sandbox: z.number().int() }),
            byOutcome: z.array(z.object({ outcome: z.string(), count: z.number().int() })),
            asOf: z.string(),
          }),
        )
        .query(async ({ input }) => {
          try {
            const counts = await runs.counts({
              from: requireWindowBound(input?.from, 'from'),
              to: requireWindowBound(input?.to, 'to'),
            });
            return {
              byKind: { backtest: counts.byKind.backtest, sandbox: counts.byKind.sandbox },
              byOutcome: counts.byOutcome.map((row) => ({ outcome: row.outcome, count: row.count })),
              asOf: counts.asOf,
            };
          } catch (err) {
            toTrpc(err);
          }
        }),

      template: router({
        /** The next version of a starter template. Every number stays blank; the row records who, why and when. */
        publish: scopedProcedure('admin:write', { module: 'quant', plane: 'fiat' })
          .input(quantTemplatePublishInputSchema)
          .output(quantTemplateVersionSchema)
          .mutation(async ({ input, ctx }) =>
            withQuantSpan('quant.ops.template.publish', { language: 'none' }, async () => {
              try {
                const published = await templates.publish({
                  id: input.id,
                  name: input.name,
                  description: input.description,
                  rules: blankTemplateRules(input.rules),
                  releaseNote: input.releaseNote,
                  reason: input.reason,
                  publishedBy: ctx.principal.userId,
                  idempotencyKey: input.idempotencyKey,
                });
                return { ...published };
              } catch (err) {
                toTrpc(err);
              }
            }),
          ),
      }),

      disclosure: router({
        publish: scopedProcedure('admin:write', { module: 'quant', plane: 'fiat' })
          .input(quantDisclosurePublishInputSchema)
          .output(quantDisclosurePublishOutputSchema)
          .mutation(async ({ input, ctx }) =>
            withQuantSpan('quant.ops.disclosure.publish', { language: 'none' }, async () => {
              try {
                const published = await disclosure.publish({
                  text: input.text,
                  reason: input.reason,
                  publishedBy: ctx.principal.userId,
                  idempotencyKey: requireIdempotencyKey(input.idempotencyKey),
                });
                return { version: published.version, publishedAt: published.publishedAt };
              } catch (err) {
                toTrpc(err);
              }
            }),
          ),

        counts: scopedProcedure('admin:read', { module: 'quant', plane: 'fiat' })
          .output(quantDisclosureCountsOutputSchema)
          .query(async () => {
            try {
              const counts = await disclosure.counts();
              return { versions: counts.versions.map((row) => ({ ...row })), asOf: new Date().toISOString() };
            } catch (err) {
              toTrpc(err);
            }
          }),
      }),
    }),
  });
}

export type QuantRouter = ReturnType<typeof createQuantRouter>;
