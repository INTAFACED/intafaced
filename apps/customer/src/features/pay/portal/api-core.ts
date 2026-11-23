import * as p from './schemas';
import { type PortalTools } from './api-tools';
import { PAY_MERCHANT_METRICS_SNAPSHOT, PAY_MERCHANT_METRICS_SERIES } from '@intafaced/contracts/pay-merchant-metrics-procedures';
import { PAY_PAY_HALTS_STATUS } from '@intafaced/contracts/pay-pay-halts-procedures';
import { PAY_MERCHANT_ME, PAY_MERCHANT_MY_ACCESS } from '@intafaced/contracts/pay-merchant-procedures';
import { PAY_RAIL_HEALTH } from '@intafaced/contracts/pay-rail-health-procedures';
import { PAY_MERCHANT_OPS_TEAM_ME } from '@intafaced/contracts/pay-merchant-ops-procedures';

export const coreApi = ({ userId, queryRecord }: PortalTools) => ({
  userId,
  /** Who the signed-in person is in each business, with what they may do. Not live on every server: the portal then works it out in `access/`. */
  myAccess: (signal?: AbortSignal) => queryRecord(PAY_MERCHANT_MY_ACCESS, {}, signal),
  merchant: (signal?: AbortSignal) => queryRecord(PAY_MERCHANT_ME, undefined, signal),
  rails: (signal?: AbortSignal) => queryRecord(PAY_RAIL_HEALTH, undefined, signal),
  snapshot: (merchantId: string, preset: p.MetricPreset, signal?: AbortSignal) =>
    queryRecord(PAY_MERCHANT_METRICS_SNAPSHOT, { merchantId, window: { kind: 'preset', preset } }, signal),
  series: (merchantId: string, from: string, to: string, signal?: AbortSignal) =>
    queryRecord(PAY_MERCHANT_METRICS_SERIES, { merchantId, from, to, bucket: 'day' }, signal),
  teamMe: (signal?: AbortSignal) => queryRecord(PAY_MERCHANT_OPS_TEAM_ME, {}, signal),
  haltStatus: (merchantId: string, signal?: AbortSignal) => queryRecord(PAY_PAY_HALTS_STATUS, { merchantId }, signal),
});
