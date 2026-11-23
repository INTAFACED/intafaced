import { QUANT_ALERT_LIST_MAX } from '@intafaced/contracts/quant-algo';
import { router } from '@intafaced/contracts/trpc';
import { QUANT_VERSION_NOT_FOUND, QuantError } from '../errors.js';
import { alertKey, checkTemplate } from '../notify/rules.js';
import { toTrpc, alertView, missingStrategy, type QuantCore, quantRefusal } from './core.js';
import { QUANT_ALERT_LIST, QUANT_ALERT_CREATE } from '@intafaced/contracts/quant-alert-procedures';
import { mountRecord } from '@intafaced/contracts/procedure-mount';

export function alertRoutes(core: QuantCore) {
  const { strategies, notify, accountOf } = core;
  return router({
    list: mountRecord(
      QUANT_ALERT_LIST,
      async ({ input, ctx }) => {
        try {
          const accountId = accountOf(ctx, input.accountId);
          const found = await strategies.get({ accountId, id: input.strategyId });
          if (!found || found.deletedAt) missingStrategy();
          const rows = await notify.alerts({ accountId, strategyId: found.id, limit: QUANT_ALERT_LIST_MAX });
          return { alerts: rows.map(alertView) };
        } catch (err) {
          toTrpc(err);
        }
      },
      quantRefusal,
    ),
    create: mountRecord(
      QUANT_ALERT_CREATE,
      async ({ input, ctx }) => {
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
      },
      quantRefusal,
    ),
  });
}
