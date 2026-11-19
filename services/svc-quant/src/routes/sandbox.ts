import { QUANT_SANDBOX_UNWIRED } from '../errors.js';
import { publicJurisdictionProcedure, router } from '@intafaced/contracts';
import { requireIdempotencyKey } from '../studio/keys.js';
import { runSandbox } from '../sandbox/run.js';
import { sandboxSourceInputMax } from '../sandbox/max.js';
import { trackRun } from '../runs/track.js';
import { withQuantSpan } from '../tracing.js';
import { z } from 'zod';
import { environmentInput, decimal, language, runOutput, toTrpc, sandboxBody, writeKeyField, type QuantCore } from './core.js';

export function sandboxRoutes(core: QuantCore) {
  const { deps, runs, runLimitsFor, runDeps } = core;
  return router({
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
            const run = await runLimitsFor(userId);
            return await trackRun(
              runs,
              {
                userId,
                idempotencyKey,
                kind: 'sandbox',
                strategyId: null,
                strategyVersion: null,
              },
              async () => runSandbox(input, runDeps(run)),
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
  });
}
