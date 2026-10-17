import * as p from './schemas';
import { type PortalTools } from './api-tools';

export const coreApi = ({ query, userId }: PortalTools) => ({
  userId,
  merchant: (signal?: AbortSignal) => query('merchant.me', undefined, p.merchantRecordSchema, signal),
  rails: (signal?: AbortSignal) => query('railHealth', undefined, p.railSchema, signal),
  snapshot: (merchantId: string, preset: p.MetricPreset, signal?: AbortSignal) =>
    query('merchantMetrics.snapshot', { merchantId, window: { kind: 'preset', preset } }, p.snapshotSchema, signal),
  series: (merchantId: string, from: string, to: string, signal?: AbortSignal) =>
    query('merchantMetrics.series', { merchantId, from, to, bucket: 'day' }, p.seriesSchema, signal),
  teamMe: (signal?: AbortSignal) => query('merchantOps.team.me', {}, p.teamMeSchema, signal),
  haltStatus: (merchantId: string, signal?: AbortSignal) => query('payHalts.status', { merchantId }, p.haltStatusSchema, signal),
});
