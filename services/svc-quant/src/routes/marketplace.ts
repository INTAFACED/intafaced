import { claimFromRun } from '../marketplace/claim.js';
import { publicJurisdictionProcedure, router } from '@intafaced/contracts';
import { requireIdempotencyKey } from '../studio/keys.js';
import { requireSimulatedStamp } from '../honesty.js';
import { withQuantSpan } from '../tracing.js';
import { z } from 'zod';
import { simulatedStamp, environmentInput, decimal, toTrpc, writeKeyField, type QuantCore } from './core.js';

export function marketplaceRoutes(core: QuantCore) {
  const { runs, accountOf } = core;
  return router({
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
  });
}
