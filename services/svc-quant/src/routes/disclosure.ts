import { QUANT_DISCLOSURE_UNSET, QUANT_DISCLOSURE_VERSION_STALE, QuantError } from '../errors.js';
import {
  publicJurisdictionProcedure,
  quantDisclosureAcceptInputSchema,
  quantDisclosureAcceptKey,
  quantDisclosureAcceptOutputSchema,
  quantDisclosureCurrentSchema,
  quantDisclosureStatusInputSchema,
  quantDisclosureStatusOutputSchema,
  router,
} from '@intafaced/contracts';
import { withQuantSpan } from '../tracing.js';
import { toTrpc, type QuantCore } from './core.js';

export function disclosureRoutes(core: QuantCore) {
  const { disclosure, accountOf, currentDisclosure, ownedStrategyVersion } = core;
  return router({
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
  });
}
