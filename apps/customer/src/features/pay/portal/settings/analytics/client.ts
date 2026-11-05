import type { SettingsBTools } from '../b-client';
import { seriesSchema } from '../../schemas';
import * as s from './schemas';

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

export const analyticsApi = ({ query }: SettingsBTools) => ({
  analyticsVolume: (q: AnalyticsQuery, cursor?: string, signal?: AbortSignal) =>
    query('merchantAnalytics.volume', input(q, cursor), s.volumeSchema, signal),
  analyticsFees: (q: AnalyticsQuery, cursor?: string, signal?: AbortSignal) =>
    query('merchantAnalytics.fees', input(q, cursor), s.feesSchema, signal),
  /** Used only where merchantAnalytics.volume is not available: the daily capture totals the account already reads. */
  analyticsDailySeries: (merchantId: string, from: string, to: string, signal?: AbortSignal) =>
    query('merchantMetrics.series', { merchantId, from, to, bucket: 'day' }, seriesSchema, signal),
});
