/**
 * `trade.riskAlerts.*`: margin and liquidation-risk alerts on an isolated position on the person's own venue account
 * (J-derivatives-06 #6 #7; risk-alerts.ts). Every door is a record (`@intafaced/contracts/trade-risk-alerts-procedures`).
 * Refusals keep their typed code on `data.cause.code`. With the user-venue door off there are no alerts, and every door
 * answers 503 `trade.risk_alerts_unavailable`.
 */
import { router, TRPCError } from '@intafaced/contracts/trpc';
import { mountRecord, type RefusalOf } from '@intafaced/contracts/procedure-mount';
import { RISK_ALERTS_GET, RISK_ALERTS_LIST, RISK_ALERTS_OFF, RISK_ALERTS_SET } from '@intafaced/contracts/trade-risk-alerts-procedures';
import { VenueRefusalError } from '@intafaced/venue-contracts';
import { RiskAlertError, type VenueRiskAlerts } from './risk-alerts.js';
import { UserVenueDoorError } from './user-venue-door.js';

const STATUS: Record<RiskAlertError['code'], TRPCError['code']> = {
  'trade.risk_alerts_unavailable': 'SERVICE_UNAVAILABLE',
  'trade.risk_alerts_request_invalid': 'BAD_REQUEST',
  'trade.risk_alerts_field_invalid': 'BAD_REQUEST',
  'trade.risk_alerts_no_position': 'CONFLICT',
};

/** The door's and the venue's own refusals (a malformed wallet, a venue that refused) leave as a request refusal, in their words. */
function asRiskAlertError(err: unknown): RiskAlertError | undefined {
  if (err instanceof RiskAlertError) return err;
  if (err instanceof UserVenueDoorError && err.status < 500) return new RiskAlertError(err.message, 'trade.risk_alerts_request_invalid');
  if (err instanceof VenueRefusalError) return new RiskAlertError(err.refusal.detail, 'trade.risk_alerts_request_invalid');
  return undefined;
}

const refusalOf: RefusalOf = (err) => {
  const e = asRiskAlertError(err);
  return e ? { code: e.code, error: new TRPCError({ code: STATUS[e.code], message: e.message, cause: e }) } : undefined;
};

export function riskAlertsRouter(alerts: VenueRiskAlerts | null | undefined) {
  const call = async <T>(fn: (a: VenueRiskAlerts) => Promise<T>): Promise<T> => {
    if (!alerts)
      throw new RiskAlertError('Risk alerts watch your own venue account, and no venue is connected', 'trade.risk_alerts_unavailable');
    return fn(alerts);
  };
  return router({
    get: mountRecord(RISK_ALERTS_GET, ({ ctx, input }) => call((a) => a.get(ctx.principal, input.owner, input.symbol)), refusalOf),
    set: mountRecord(RISK_ALERTS_SET, ({ ctx, input }) => call((a) => a.set(ctx.principal, input)), refusalOf),
    off: mountRecord(RISK_ALERTS_OFF, ({ ctx, input }) => call((a) => a.off(ctx.principal, input.owner, input.symbol)), refusalOf),
    list: mountRecord(RISK_ALERTS_LIST, ({ ctx, input }) => call((a) => a.list(ctx.principal, input.owner)), refusalOf),
  });
}
