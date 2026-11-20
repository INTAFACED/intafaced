import {
  QUANT_BACKTEST_RULES_REQUIRED,
  QUANT_PAPER_LIST_LIMIT_UNSET,
  QUANT_RUN_IMMUTABLE,
  QUANT_RUN_NOT_FOUND,
  QuantError,
} from '../errors.js';
import {
  QUANT_PAPER_FEEDS,
  QUANT_PAPER_LIST_MAX,
  TRPCError,
  publicJurisdictionProcedure,
  quantPaperListSchema,
  quantPaperRunSchema,
  quantPaperStartInputSchema,
  router,
} from '@intafaced/contracts';
import { paperKey, paperSettingsOf } from '../paper/view.js';
import { withQuantSpan } from '../tracing.js';
import { z } from 'zod';
import { toTrpc, accountField, missingStrategy, type QuantCore } from './core.js';

export function paperRoutes(core: QuantCore) {
  const { strategies, runs, presentPaper, accountOf } = core;
  return router({
    /**
     * Starts a paper run of one saved signal-rules version on the exchange's own prices (AL-live-01). The key is derived
     * from the version's run count the start dialog read, so a retry after a lost reply reads the same run. An outside
     * market feed refuses `feed.market` and stores nothing. The start counts against the plan (AL-limits-01).
     */
    start: publicJurisdictionProcedure('quant', 'fiat')
      .input(quantPaperStartInputSchema.extend(accountField))
      .output(quantPaperRunSchema)
      .mutation(async ({ input, ctx }) =>
        withQuantSpan('quant.paper.start', { language: 'rules' }, async () => {
          try {
            const accountId = accountOf(ctx, input.accountId);
            const found = await strategies.get({ accountId, id: input.strategyId });
            const version = found && !found.deletedAt ? found.versions.find((row) => row.version === input.strategyVersion) : undefined;
            if (!found || !version) missingStrategy();
            const key = paperKey(found.id, version.version, input.ordinal);
            const prior = await runs.replay(accountId, key);
            const priorPaper = prior ? await runs.paperRun({ userId: accountId, id: prior.id }) : null;
            if (priorPaper) return await presentPaper(accountId, priorPaper);
            const feed = input.feed.trim();
            if (feed !== 'own_venue') {
              if ((QUANT_PAPER_FEEDS as readonly string[]).includes(feed)) {
                throw new TRPCError({
                  code: 'PRECONDITION_FAILED',
                  message: 'feed.market — an outside market feed is needed for this and is switched off in this build; no run was started',
                });
              }
              throw new QuantError('quant.params_invalid', `feed — ${feed || 'blank'} is not a data feed`);
            }
            if (!version.modules) {
              throw new QuantError(QUANT_BACKTEST_RULES_REQUIRED, 'a paper run runs signal rules; this version trades by order blocks');
            }
            const settings = paperSettingsOf(input);
            const begun = await runs.begin({
              userId: accountId,
              idempotencyKey: key,
              kind: 'paper',
              strategyId: found.id,
              strategyVersion: version.version,
              paper: settings,
            });
            const paper = await runs.paperRun({ userId: accountId, id: begun.id });
            if (!paper) throw new QuantError(QUANT_RUN_NOT_FOUND, 'run not found');
            return await presentPaper(accountId, paper);
          } catch (err) {
            if (err instanceof TRPCError) throw err;
            toTrpc(err);
          }
        }),
      ),

    /** Stops one of the caller's paper runs: no new order after this, and the record stays. Stopping again changes nothing. */
    stop: publicJurisdictionProcedure('quant', 'fiat')
      .input(z.object({ runId: z.string().min(1).max(128), ...accountField }))
      .output(quantPaperRunSchema)
      .mutation(async ({ input, ctx }) => {
        try {
          const accountId = accountOf(ctx, input.accountId);
          const paper = await runs.paperRun({ userId: accountId, id: input.runId });
          if (!paper) throw new QuantError(QUANT_RUN_NOT_FOUND, 'run not found');
          if (!paper.run.finished) {
            try {
              await runs.finish({
                id: paper.run.id,
                userId: accountId,
                outcome: 'stopped',
                stored: { detail: null, response: { stopped: true } },
              });
            } catch (err) {
              // Stopped by another tab first: the row is finished either way.
              if (!(err instanceof QuantError) || err.code !== QUANT_RUN_IMMUTABLE) throw err;
            }
          }
          const stopped = await runs.paperRun({ userId: accountId, id: input.runId });
          if (!stopped) throw new QuantError(QUANT_RUN_NOT_FOUND, 'run not found');
          return await presentPaper(accountId, stopped);
        } catch (err) {
          toTrpc(err);
        }
      }),

    /** The caller's paper runs of one strategy, newest first, with each version's run count. A blank page size refuses. */
    list: publicJurisdictionProcedure('quant', 'fiat')
      .input(
        z.object({
          strategyId: z.string().min(1).max(128),
          limit: z.number().int().min(1).max(QUANT_PAPER_LIST_MAX).optional(),
          ...accountField,
        }),
      )
      .output(quantPaperListSchema)
      .query(async ({ input, ctx }) => {
        try {
          const accountId = accountOf(ctx, input.accountId);
          if (input.limit === undefined) {
            throw new QuantError(QUANT_PAPER_LIST_LIMIT_UNSET, 'limit — the page size of the paper run list is unset');
          }
          // Every run of the strategy, for the counts; the plan's paper-run limit bounds how many there are.
          const all = await runs.paperRuns({ userId: accountId, strategyId: input.strategyId, limit: 10_000 });
          const counts = new Map<number, number>();
          for (const row of all) counts.set(row.run.strategyVersion ?? 0, (counts.get(row.run.strategyVersion ?? 0) ?? 0) + 1);
          return {
            runs: all.slice(0, input.limit).map((row) => ({
              runId: row.run.id,
              strategyId: row.run.strategyId ?? '',
              strategyVersion: row.run.strategyVersion ?? 1,
              state: row.run.finished ? ('stopped' as const) : ('running' as const),
              startedAt: row.run.started,
              stoppedAt: row.run.finished,
              cash: row.settings.cash,
              feed: row.settings.feed,
            })),
            counts: [...counts.entries()]
              .filter(([version]) => version > 0)
              .sort((a, b) => a[0] - b[0])
              .map(([strategyVersion, n]) => ({ strategyVersion, runs: n })),
          };
        } catch (err) {
          toTrpc(err);
        }
      }),

    /** One of the caller's paper runs, with its fills, position and equity derived on this read. */
    get: publicJurisdictionProcedure('quant', 'fiat')
      .input(z.object({ runId: z.string().min(1).max(128), ...accountField }))
      .output(quantPaperRunSchema)
      .query(async ({ input, ctx }) => {
        try {
          const accountId = accountOf(ctx, input.accountId);
          const paper = await runs.paperRun({ userId: accountId, id: input.runId });
          if (!paper) throw new QuantError(QUANT_RUN_NOT_FOUND, 'run not found');
          return await presentPaper(accountId, paper);
        } catch (err) {
          toTrpc(err);
        }
      }),
  });
}
