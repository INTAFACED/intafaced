import {
  BACKTEST_HISTORY_PAGE_MAX,
  BAR_BACKTEST_KEY_PREFIX,
  type StoredBacktest,
  isBarBacktest,
  prepareBacktest,
  presentBacktest,
  readStoredBacktest,
  readWindowBars,
  runOnBars,
} from '../engine/run.js';
import { type BacktestCostModel } from '@intafaced/quant-honesty';
import {
  QUANT_MONTECARLO_MIN_TRADES_UNSET,
  QUANT_MONTECARLO_RUNS_UNSET,
  QUANT_RUN_IMMUTABLE,
  QUANT_RUN_NOT_FOUND,
  QuantError,
} from '../errors.js';
import {
  QUANT_RUN_LABEL_MAX,
  publicJurisdictionProcedure,
  quantAccountRulesSchema,
  quantBacktestFeeSchema,
  quantBacktestHistorySchema,
  quantBacktestInputSchema,
  quantBacktestResultSchema,
  quantMonteCarloInputSchema,
  quantMonteCarloSchema,
  quantReportSchema,
  router,
} from '@intafaced/contracts';
import { type QuantContext, claimKeyIdempotency } from '../key-api/key-api.js';
import { type RunResultBody } from '../runs/types.js';
import { backtestBodyOf, runBacktest } from '../backtest/run.js';
import { formatAmount } from '@intafaced/ledger-client/money';
import { idempotencyConflict, requireIdempotencyKey } from '../studio/keys.js';
import { monteCarlo } from '../backtest/montecarlo.js';
import { reportOf } from '../report/document.js';
import { trackRun } from '../runs/track.js';
import { verdictCriteriaOf } from '../lifecycle/gate.js';
import { withQuantSpan } from '../tracing.js';
import { z } from 'zod';
import {
  environmentInput,
  toTrpc,
  costEvidence,
  runDetailOutput,
  backtestOutput,
  accountField,
  writeKeyField,
  missingStrategy,
  type QuantCore,
} from './core.js';

export function backtestRoutes(core: QuantCore) {
  const {
    deps,
    strategies,
    keyIdempotency,
    runs,
    lake,
    history,
    fees,
    now,
    judgement,
    lifecycle,
    equityStopOf,
    replayOf,
    accountOf,
    ownedBar,
  } = core;
  return router({
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

    /** The published rate a bar backtest of this symbol charges, with the schedule version. Read only. */
    fee: publicJurisdictionProcedure('quant', 'fiat')
      .input(z.object({ symbol: z.string().min(1).max(32) }))
      .output(quantBacktestFeeSchema)
      .query(async ({ input }) => {
        try {
          const symbol = input.symbol.trim();
          const fee = await fees.fee(symbol);
          return { symbol, version: fee.version, makerBps: fee.makerBps, takerBps: fee.takerBps };
        } catch (err) {
          toTrpc(err);
        }
      }),

    /** The simulated account's published margin rules (ENGINE RK-5), read only; a blank one reads null. */
    accountRules: publicJurisdictionProcedure('quant', 'fiat')
      .output(quantAccountRulesSchema)
      .query(() => judgement.account),

    /**
     * Runs a saved signal-rules version on the exchange's own closed bars (AL-backtest-01, AL-backtest-02). The run key
     * is derived from everything that decides the result, so the same inputs read back the same stored run and a lost
     * reply is answered by pressing Run again. A refusal before the engine stores no row.
     */
    start: publicJurisdictionProcedure('quant', 'fiat')
      .input(quantBacktestInputSchema.extend(accountField))
      .output(quantBacktestResultSchema)
      .mutation(async ({ input, ctx }) =>
        withQuantSpan('quant.backtest.start', { language: 'rules' }, async () => {
          try {
            const accountId = accountOf(ctx, input.accountId);
            // A key sends an Idempotency-Key; the same key for a different request runs nothing (J-algo-dev-14 #4).
            await claimKeyIdempotency(ctx as QuantContext, accountId, 'backtest.start', input, keyIdempotency, new Date(now()));
            const found = await strategies.get({ accountId, id: input.strategyId });
            const version = found && !found.deletedAt ? found.versions.find((row) => row.version === input.strategyVersion) : undefined;
            if (!found || !version) missingStrategy();
            const prepared = await prepareBacktest(
              input,
              {
                id: found.id,
                version: version.version,
                modules: version.modules,
                risk: version.risk,
                equityStop: await equityStopOf(accountId, found.id),
              },
              fees,
              now(),
              // The owner's out-of-sample criteria as they stand now: an operator's stored value wins over the boot one.
              { ...judgement, criteria: verdictCriteriaOf(await lifecycle.criteria(), judgement.criteria) },
            );
            // What this request sent that only the service may set is named on the answer, also when it replays a run.
            const withRun = async (result: StoredBacktest) => {
              const row = await runs.replay(accountId, prepared.key);
              return presentBacktest({ ...result, ignoredInputs: [...prepared.ignoredInputs] }, row?.id ?? '');
            };
            const prior = await runs.replay(accountId, prepared.key);
            if (prior?.finished && prior.outcome === 'ok') {
              // A stored result is read back, never run again; one that no longer reads is refused, not replaced.
              const stored = readStoredBacktest(prior.response);
              if (!stored) throw new QuantError(QUANT_RUN_IMMUTABLE, 'run — its stored result cannot be read; it is not run again');
              return withRun(stored);
            }
            // Bars are read before the run row, so a history read that fails stores nothing and the same key can run later.
            const bars = await readWindowBars(prepared, history);
            const result = await trackRun(
              runs,
              {
                userId: accountId,
                idempotencyKey: prepared.key,
                kind: 'backtest',
                strategyId: found.id,
                strategyVersion: version.version,
              },
              async () => {
                // This run is one more variant: the account's earlier distinct runs of the family, and this one.
                const earlier = await runs.variantCount({
                  userId: accountId,
                  strategyId: found.id,
                  symbol: prepared.rules.symbol,
                  barSize: prepared.rules.barSize,
                  keyPrefix: BAR_BACKTEST_KEY_PREFIX,
                });
                return runOnBars(prepared, bars, earlier + 1);
              },
              (value, err) => ({
                detail: err
                  ? null
                  : {
                      equityCurve: value.equity,
                      trades: value.trades.map((trade) => ({ ts: trade.ts, symbol: value.symbol, qty: trade.qty, price: trade.price })),
                      costs: null,
                      pnl: value.totals.net,
                      simulated: true,
                      live: false,
                      environment: 'backtest',
                      kind: 'simulated',
                      claimLabel: value.claimLabel,
                    },
                response: err ? null : value,
              }),
            );
            return withRun(result);
          } catch (err) {
            toTrpc(err);
          }
        }),
      ),

    /** A stored bar backtest of the caller's own. Another account's run reads as not found. */
    result: publicJurisdictionProcedure('quant', 'fiat')
      .input(z.object({ runId: z.string().min(1), ...accountField }))
      .output(quantBacktestResultSchema)
      .query(async ({ input, ctx }) => {
        try {
          const userId = accountOf(ctx, input.accountId);
          const row = await runs.get({ userId, id: input.runId });
          const stored = row && isBarBacktest(row) ? readStoredBacktest(row.response) : null;
          if (!row || !stored) throw new QuantError(QUANT_RUN_NOT_FOUND, 'run not found');
          return presentBacktest(stored, row.id);
        } catch (err) {
          toTrpc(err);
        }
      }),

    /**
     * Monte Carlo resampling of one finished bar backtest of the caller's (RC-algo-dev-04; J-algo-dev-16 #3): the
     * owner's path count and fewest round trips, the caller's seed. Deterministic, so the same run, count and seed
     * read back the same distribution every time; nothing is stored and nothing moves.
     */
    monteCarlo: publicJurisdictionProcedure('quant', 'fiat')
      .input(quantMonteCarloInputSchema.extend(accountField))
      .output(quantMonteCarloSchema)
      .query(async ({ input, ctx }) => {
        try {
          const userId = accountOf(ctx, input.accountId);
          const row = await runs.get({ userId, id: input.runId });
          const stored = row && isBarBacktest(row) ? readStoredBacktest(row.response) : null;
          if (!row || !stored) throw new QuantError(QUANT_RUN_NOT_FOUND, 'run not found');
          const owner = deps.monteCarlo ?? { runs: null, minTrades: null };
          if (owner.runs === null) {
            throw new QuantError(QUANT_MONTECARLO_RUNS_UNSET, 'QUANT_MONTECARLO_RUNS — how many paths a resampling draws is not set');
          }
          if (owner.minTrades === null) {
            throw new QuantError(
              QUANT_MONTECARLO_MIN_TRADES_UNSET,
              'QUANT_MONTECARLO_MIN_TRADES — the fewest round trips a run needs to be resampled is not set',
            );
          }
          const floor = stored.strategyId ? await equityStopOf(userId, stored.strategyId) : null;
          const result = monteCarlo({
            trades: stored.trades,
            startCash: stored.totals.startCash,
            ruinLevel: floor ? formatAmount(floor.floor) : null,
            runs: owner.runs,
            seed: input.seed,
            minTrades: owner.minTrades,
          });
          return {
            runId: row.id,
            ...result,
            startCash: stored.totals.startCash,
            simulated: true as const,
            live: false as const,
            claimLabel: 'Simulated resampling of a historical simulation — not a forecast' as const,
          };
        } catch (err) {
          toTrpc(err);
        }
      }),

    /** The caller's own bar backtests, newest first, with label, version and outcome (AL-backtest-03). */
    history: publicJurisdictionProcedure('quant', 'fiat')
      .input(
        z.object({
          limit: z.number().int().min(1).max(BACKTEST_HISTORY_PAGE_MAX),
          cursor: z.string().optional().nullable(),
          /** Only one strategy's runs (its own page). Another account's strategy id simply matches none. */
          strategyId: z.string().min(1).max(128).optional(),
          ...accountField,
        }),
      )
      .output(quantBacktestHistorySchema)
      .query(async ({ input, ctx }) => {
        try {
          const userId = accountOf(ctx, input.accountId);
          const cursor = input.cursor?.trim() ? input.cursor.trim() : null;
          const page = await runs.history({
            userId,
            kind: 'backtest',
            keyPrefix: BAR_BACKTEST_KEY_PREFIX,
            limit: input.limit,
            cursor,
            strategyId: input.strategyId ?? null,
          });
          return {
            runs: page.runs.map((row) => ({
              runId: row.id,
              strategyId: row.strategyId,
              strategyVersion: row.strategyVersion,
              started: row.started,
              finished: row.finished,
              outcome: row.outcome,
              label: row.label,
            })),
            nextCursor: page.nextCursor,
          };
        } catch (err) {
          toTrpc(err);
        }
      }),

    /**
     * Names one of the caller's own runs. The same label again changes nothing; the run and its stored result are
     * never touched. Another account's run reads as not found.
     */
    rename: publicJurisdictionProcedure('quant', 'fiat')
      .input(z.object({ runId: z.string().min(1), label: z.string(), ...accountField }))
      .output(z.object({ runId: z.string(), label: z.string() }))
      .mutation(async ({ input, ctx }) => {
        try {
          const userId = accountOf(ctx, input.accountId);
          const label = input.label.trim();
          if (!label || label.length > QUANT_RUN_LABEL_MAX) {
            throw new QuantError('quant.params_invalid', `label — a run label is 1 to ${QUANT_RUN_LABEL_MAX} characters`);
          }
          const row = await runs.get({ userId, id: input.runId });
          if (!row || !isBarBacktest(row)) throw new QuantError(QUANT_RUN_NOT_FOUND, 'run not found');
          const saved = await runs.setLabel({ userId, runId: row.id, label });
          return { runId: row.id, label: saved.label };
        } catch (err) {
          toTrpc(err);
        }
      }),

    /** The print document of one of the caller's own bar backtests (AL-report-03). Derived on read. */
    report: publicJurisdictionProcedure('quant', 'fiat')
      .input(z.object({ runId: z.string().min(1), ...accountField }))
      .output(quantReportSchema)
      .query(async ({ input, ctx }) => {
        try {
          const owned = await ownedBar(accountOf(ctx, input.accountId), input.runId);
          return reportOf(presentBacktest(owned.stored, owned.id));
        } catch (err) {
          toTrpc(err);
        }
      }),
  });
}
