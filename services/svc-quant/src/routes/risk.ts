import { checkCaps, checkTradingOn, riskScreenOf } from '../risk/rules.js';
import {
  publicJurisdictionProcedure,
  quantRiskScreenSchema,
  quantRiskSetInputSchema,
  quantRiskTradingInputSchema,
  router,
} from '@intafaced/contracts';
import { z } from 'zod';
import { toTrpc, accountField, type QuantCore } from './core.js';

export function riskRoutes(core: QuantCore) {
  const { risk, liveStrategy, newestVersion, accountOf } = core;
  return router({
    get: publicJurisdictionProcedure('quant', 'fiat')
      .input(z.object({ strategyId: z.string().min(1).max(128), ...accountField }))
      .output(quantRiskScreenSchema)
      .query(async ({ input, ctx }) => {
        try {
          const accountId = accountOf(ctx, input.accountId);
          const found = await liveStrategy(accountId, input.strategyId);
          return riskScreenOf(found.id, newestVersion(found), await risk.get({ accountId, strategyId: found.id }));
        } catch (err) {
          toTrpc(err);
        }
      }),
    set: publicJurisdictionProcedure('quant', 'fiat')
      .input(quantRiskSetInputSchema.extend(accountField))
      .output(quantRiskScreenSchema)
      .mutation(async ({ input, ctx }) => {
        try {
          const accountId = accountOf(ctx, input.accountId);
          const found = await liveStrategy(accountId, input.strategyId);
          const { caps, floorPolicy } = checkCaps(input.caps, input.floorPolicy);
          const saved = await risk.saveCaps({ accountId, strategyId: found.id, caps, floorPolicy });
          // A cap cleared while trading is on turns the switch off: it never stays on with a blank cap.
          const latest = newestVersion(found);
          if (saved.tradingVersion !== null && Object.values(caps).some((value) => value === null)) {
            return riskScreenOf(found.id, latest, await risk.setTrading({ accountId, strategyId: found.id, version: null }));
          }
          return riskScreenOf(found.id, latest, saved);
        } catch (err) {
          toTrpc(err);
        }
      }),
    trading: publicJurisdictionProcedure('quant', 'fiat')
      .input(quantRiskTradingInputSchema.extend(accountField))
      .output(quantRiskScreenSchema)
      .mutation(async ({ input, ctx }) => {
        try {
          const accountId = accountOf(ctx, input.accountId);
          const found = await liveStrategy(accountId, input.strategyId);
          const latest = newestVersion(found);
          if (input.on) checkTradingOn(await risk.get({ accountId, strategyId: found.id }));
          const saved = await risk.setTrading({ accountId, strategyId: found.id, version: input.on ? latest : null });
          return riskScreenOf(found.id, latest, saved);
        } catch (err) {
          toTrpc(err);
        }
      }),
  });
}
