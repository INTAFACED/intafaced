import {
  QUANT_ALERT_LIST_MAX,
  publicJurisdictionProcedure,
  quantAlertCreateInputSchema,
  quantAlertListSchema,
  quantAlertSchema,
  router,
} from '@intafaced/contracts';
import { QUANT_VERSION_NOT_FOUND, QuantError } from '../errors.js';
import { alertKey, checkTemplate } from '../notify/rules.js';
import { z } from 'zod';
import { toTrpc, accountField, alertView, missingStrategy, type QuantCore } from './core.js';

export function alertRoutes(core: QuantCore) {
  const { strategies, notify, accountOf } = core;
  return router({
    list: publicJurisdictionProcedure('quant', 'fiat')
      .input(z.object({ strategyId: z.string().min(1).max(128), ...accountField }))
      .output(quantAlertListSchema)
      .query(async ({ input, ctx }) => {
        try {
          const accountId = accountOf(ctx, input.accountId);
          const found = await strategies.get({ accountId, id: input.strategyId });
          if (!found || found.deletedAt) missingStrategy();
          const rows = await notify.alerts({ accountId, strategyId: found.id, limit: QUANT_ALERT_LIST_MAX });
          return { alerts: rows.map(alertView) };
        } catch (err) {
          toTrpc(err);
        }
      }),
    create: publicJurisdictionProcedure('quant', 'fiat')
      .input(quantAlertCreateInputSchema.extend(accountField))
      .output(quantAlertSchema)
      .mutation(async ({ input, ctx }) => {
        try {
          const accountId = accountOf(ctx, input.accountId);
          const found = await strategies.get({ accountId, id: input.strategyId });
          if (!found || found.deletedAt) missingStrategy();
          const key = alertKey(found.id, accountId, input.ordinal);
          const version = found.versions.find((row) => row.version === input.strategyVersion);
          if (!version) throw new QuantError(QUANT_VERSION_NOT_FOUND, `version ${input.strategyVersion} not found`);
          const template = checkTemplate(input.template);
          const existing = await notify.alerts({ accountId, strategyId: found.id, limit: QUANT_ALERT_LIST_MAX });
          if (existing.length >= QUANT_ALERT_LIST_MAX && !existing.some((row) => row.key === key)) {
            throw new QuantError('quant.params_invalid', `alerts — a strategy holds at most ${QUANT_ALERT_LIST_MAX} alerts`);
          }
          const saved = await notify.createAlert({ accountId, strategyId: found.id, strategyVersion: version.version, template, key });
          return alertView(saved);
        } catch (err) {
          toTrpc(err);
        }
      }),
  });
}
