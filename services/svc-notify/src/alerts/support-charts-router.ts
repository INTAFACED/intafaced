import type { SupportChartsAlertsRead } from '@intafaced/contracts';
import {
  SUPPORT_CHARTS_ALERTS_MAX,
  SUPPORT_CHARTS_HISTORY_MAX,
  SUPPORT_CHARTS_READERS,
  supportChartsAlertsInputSchema,
  supportChartsAlertsReadSchema,
} from '@intafaced/contracts/support-charts-lookup';
import { router, serviceProcedureFor, TRPCError } from '@intafaced/contracts/trpc';
import { AlertLimitError, type AlertService } from './service.js';
import { NOTIFY_ALERT_TRIGGER_LOG_RETENTION_UNSET } from './trigger-log.js';

/**
 * `supportCharts.alerts`: one account's price alerts and their trigger history, for svc-support's ticket lookup
 * (C-ops-03 (a), J-charts-desk-19 #1). `serviceProcedureFor(SUPPORT_CHARTS_READERS)` admits svc-support alone: a customer
 * principal never reaches it, so no one reads another person's alerts here. svc-support names the account from its
 * ticket and writes the audit row before it asks.
 *
 * Read-only. A mutation only so the call is POST and its exact body is signed, as the guest verification door's `get`.
 * The alert's webhook address and channel choice stay out: the desk does not need them. A trigger log the owner has not
 * given a retention reads `unread`, never an empty history.
 */
export async function supportChartsAlertsOf(
  alerts: AlertService,
  userId: string,
  now: Date = new Date(),
): Promise<SupportChartsAlertsRead> {
  const rows = await alerts.list(userId, SUPPORT_CHARTS_ALERTS_MAX + 1);
  let history: SupportChartsAlertsRead['history'];
  try {
    const log = await alerts.triggers(userId, { limit: SUPPORT_CHARTS_HISTORY_MAX + 1 }, now);
    history = {
      status: 'read',
      retentionDays: log.retentionDays,
      more: log.triggers.length > SUPPORT_CHARTS_HISTORY_MAX,
      items: log.triggers.slice(0, SUPPORT_CHARTS_HISTORY_MAX).map((t) => ({
        alertId: t.alertId,
        seq: t.seq,
        marketId: t.marketId,
        condition: t.condition,
        targetPrice: t.targetPrice,
        markPrice: t.markPrice,
        firedAt: t.firedAt.toISOString(),
      })),
    };
  } catch (err) {
    if (!(err instanceof AlertLimitError && err.code === NOTIFY_ALERT_TRIGGER_LOG_RETENTION_UNSET)) throw err;
    history = { status: 'unread', reason: 'retention_unset' };
  }
  return {
    userId,
    more: rows.length > SUPPORT_CHARTS_ALERTS_MAX,
    alerts: rows.slice(0, SUPPORT_CHARTS_ALERTS_MAX).map((a) => ({
      id: a.id,
      marketId: a.marketId,
      kind: a.kind,
      condition: a.condition,
      targetPrice: a.targetPrice,
      status: a.status,
      name: a.name,
      source: a.source,
      frequency: a.frequency,
      fireCount: a.fireCount,
      createdAt: a.createdAt.toISOString(),
      firedAt: a.firedAt ? a.firedAt.toISOString() : null,
      lastFiredAt: a.lastFiredAt ? a.lastFiredAt.toISOString() : null,
      expiresAt: a.expiresAt ? a.expiresAt.toISOString() : null,
    })),
    history,
  };
}

export function supportChartsRouter(alerts?: AlertService) {
  const reader = serviceProcedureFor(SUPPORT_CHARTS_READERS);
  return router({
    alerts: reader
      .input(supportChartsAlertsInputSchema)
      .output(supportChartsAlertsReadSchema)
      .mutation(async ({ input }) => {
        if (!alerts) throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'notify.alerts_unwired' });
        return supportChartsAlertsOf(alerts, input.userId);
      }),
  });
}
