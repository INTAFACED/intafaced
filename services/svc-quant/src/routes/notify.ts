import { checkChannels } from '../notify/rules.js';
import { router } from '@intafaced/contracts';
import { mountRecord } from '@intafaced/contracts/procedure-mount';
import { QUANT_NOTIFY_GET, QUANT_NOTIFY_SET } from '@intafaced/contracts/quant-strategy-settings-procedures';
import { quantRefusal, toTrpc, missingStrategy, type QuantCore } from './core.js';

/** `quant.notify.*`, mounted from its records (`@intafaced/contracts/quant-strategy-settings-procedures`). */
export function notifyRoutes(core: QuantCore) {
  const { strategies, notify, accountOf } = core;
  return router({
    get: mountRecord(
      QUANT_NOTIFY_GET,
      async ({ input, ctx }) => {
        try {
          const accountId = accountOf(ctx, input.accountId);
          const found = await strategies.get({ accountId, id: input.strategyId });
          if (!found || found.deletedAt) missingStrategy();
          const saved = await notify.settings({ accountId, strategyId: found.id });
          return {
            strategyId: found.id,
            channels: saved ? [...saved.channels] : ['inapp' as const],
            updatedAt: saved?.updatedAt ?? null,
          };
        } catch (err) {
          toTrpc(err);
        }
      },
      quantRefusal,
    ),
    set: mountRecord(
      QUANT_NOTIFY_SET,
      async ({ input, ctx }) => {
        try {
          const accountId = accountOf(ctx, input.accountId);
          const found = await strategies.get({ accountId, id: input.strategyId });
          if (!found || found.deletedAt) missingStrategy();
          const channels = checkChannels(input.channels);
          const saved = await notify.saveSettings({ accountId, strategyId: found.id, channels });
          return { strategyId: found.id, channels: [...saved.channels], updatedAt: saved.updatedAt };
        } catch (err) {
          toTrpc(err);
        }
      },
      quantRefusal,
    ),
  });
}
