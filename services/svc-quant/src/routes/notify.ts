import { checkChannels } from '../notify/rules.js';
import { publicJurisdictionProcedure, quantNotifySetInputSchema, quantNotifySettingsSchema, router } from '@intafaced/contracts';
import { z } from 'zod';
import { toTrpc, accountField, missingStrategy, type QuantCore } from './core.js';

export function notifyRoutes(core: QuantCore) {
  const { strategies, notify, accountOf } = core;
  return router({
    get: publicJurisdictionProcedure('quant', 'fiat')
      .input(z.object({ strategyId: z.string().min(1).max(128), ...accountField }))
      .output(quantNotifySettingsSchema)
      .query(async ({ input, ctx }) => {
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
      }),
    set: publicJurisdictionProcedure('quant', 'fiat')
      .input(quantNotifySetInputSchema.extend(accountField))
      .output(quantNotifySettingsSchema)
      .mutation(async ({ input, ctx }) => {
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
      }),
  });
}
