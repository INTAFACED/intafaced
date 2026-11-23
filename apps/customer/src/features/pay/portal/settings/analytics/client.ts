import type { SettingsBTools } from '../b-client';
import * as s from './schemas';
import { PAY_MERCHANT_METRICS_SERIES } from '@intafaced/contracts/pay-merchant-metrics-procedures';
import { PAY_MERCHANT_ANALYTICS_FEES, PAY_MERCHANT_ANALYTICS_VOLUME } from '@intafaced/contracts/pay-merchant-analytics-procedures';

export type AnalyticsQuery = { merchantId: string; from: string; to: string; bucket: 'day' | 'week'; assetId?: string };
const input = (q: AnalyticsQuery, cursor?: string) => ({
  merchantId: q.merchantId,
  from: q.from,
  to: q.to,
  bucket: q.bucket,
  limit: 200,
  ...(q.assetId ? { assetId: q.assetId } : {}),
  ...(cursor ? { cursor } : {}),
});

export const analyticsApi = ({ query, queryRecord }: SettingsBTools) => ({
  analyticsVolume: (q: AnalyticsQuery, cursor?: string, signal?: AbortSignal) =>
    queryRecord(PAY_MERCHANT_ANALYTICS_VOLUME, input(q, cursor), signal),
  analyticsFees: (q: AnalyticsQuery, cursor?: string, signal?: AbortSignal) =>
    queryRecord(PAY_MERCHANT_ANALYTICS_FEES, input(q, cursor), signal),
  analyticsDeclines: (q: { merchantId: string; from: string; to: string; assetId?: string }, signal?: AbortSignal) =>
    query(
      'merchantAnalytics.declines',
      { merchantId: q.merchantId, from: q.from, to: q.to, ...(q.assetId ? { assetId: q.assetId } : {}) },
      s.declinesSchema,
      signal,
    ),
  /** Used only where merchantAnalytics.volume is not available: the daily capture totals the account already reads. */
  analyticsDailySeries: (merchantId: string, from: string, to: string, signal?: AbortSignal) =>
    queryRecord(PAY_MERCHANT_METRICS_SERIES, { merchantId, from, to, bucket: 'day' }, signal),
});
