import { checkCaps, checkTradingOn, riskScreenOf } from '../risk/rules.js';
import { router } from '@intafaced/contracts/trpc';
import { mountRecord } from '@intafaced/contracts/procedure-mount';
import { QUANT_RISK_GET, QUANT_RISK_SET, QUANT_RISK_TRADING } from '@intafaced/contracts/quant-strategy-settings-procedures';
import { quantRefusal, toTrpc, type QuantCore } from './core.js';

/** `quant.risk.*`, mounted from its records (`@intafaced/contracts/quant-strategy-settings-procedures`). */
export function riskRoutes(core: QuantCore) {
  const { risk, liveStrategy, newestVersion, accountOf } = core;
  return router({
    get: mountRecord(
      QUANT_RISK_GET,
      async ({ input, ctx }) => {
        try {
          const accountId = accountOf(ctx, input.accountId);
          const found = await liveStrategy(accountId, input.strategyId);
          return riskScreenOf(found.id, newestVersion(found), await risk.get({ accountId, strategyId: found.id }));
        } catch (err) {
          toTrpc(err);
        }
      },
      quantRefusal,
    ),
    set: mountRecord(
      QUANT_RISK_SET,
      async ({ input, ctx }) => {
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
      },
      quantRefusal,
    ),
    trading: mountRecord(
      QUANT_RISK_TRADING,
      async ({ input, ctx }) => {
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
      },
      quantRefusal,
    ),
  });
}
