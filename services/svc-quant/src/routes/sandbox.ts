import { QUANT_SANDBOX_SYNTAX, QUANT_SANDBOX_UNWIRED, QuantError } from '../errors.js';
import { router } from '@intafaced/contracts/trpc';
import { mountRecord } from '@intafaced/contracts/procedure-mount';
import { QUANT_SANDBOX_CAPABILITIES, QUANT_SANDBOX_RUN } from '@intafaced/contracts/quant-sandbox-procedures';
import { requireIdempotencyKey } from '../studio/keys.js';
import { runSandbox } from '../sandbox/run.js';
import { sandboxSourceInputMax } from '../sandbox/max.js';
import { trackRun } from '../runs/track.js';
import { withQuantSpan } from '../tracing.js';
import { quantRefusal, toTrpc, sandboxBody, type QuantCore } from './core.js';

/** `quant.sandbox.*`, mounted from its records (`@intafaced/contracts/quant-sandbox-procedures`). */
export function sandboxRoutes(core: QuantCore) {
  const { deps, runs, runLimitsFor, runDeps } = core;
  return router({
    capabilities: mountRecord(
      QUANT_SANDBOX_CAPABILITIES,
      () => ({
        isolate: deps.wired ? ('wired' as const) : ('unwired' as const),
        languages: ['javascript', 'typescript', 'python'] as const,
        venueVault: deps.venueVaultSet ? ('trade-only' as const) : ('unset' as const),
        refuse: deps.wired ? null : QUANT_SANDBOX_UNWIRED,
      }),
      quantRefusal,
    ),

    run: mountRecord(
      QUANT_SANDBOX_RUN,
      async ({ input, ctx }) =>
        withQuantSpan('quant.sandbox.run', { language: input.language }, async () => {
          try {
            // The record takes any deployment's longest source; this deployment's own pin refuses before anything is stored.
            const maxSource = sandboxSourceInputMax(deps.limits.maxSource);
            if (input.source.length > maxSource) {
              throw new QuantError(QUANT_SANDBOX_SYNTAX, `source longer than ${maxSource} characters`);
            }
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
      quantRefusal,
    ),
  });
}
