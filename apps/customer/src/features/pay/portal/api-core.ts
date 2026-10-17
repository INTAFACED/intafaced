import * as p from './schemas';
import { myAccessSchema } from './access/schemas';
import { type PortalTools } from './api-tools';

export const coreApi = ({ query, userId }: PortalTools) => ({
  userId,
  /** Who the signed-in person is in each business, with what they may do. Not live on every server: the portal then works it out in `access/`. */
  myAccess: (signal?: AbortSignal) => query('merchant.myAccess', {}, myAccessSchema, signal),
  merchant: (signal?: AbortSignal) => query('merchant.me', undefined, p.merchantRecordSchema, signal),
  rails: (signal?: AbortSignal) => query('railHealth', undefined, p.railSchema, signal),
  snapshot: (merchantId: string, preset: p.MetricPreset, signal?: AbortSignal) =>
    query('merchantMetrics.snapshot', { merchantId, window: { kind: 'preset', preset } }, p.snapshotSchema, signal),
  series: (merchantId: string, from: string, to: string, signal?: AbortSignal) =>
    query('merchantMetrics.series', { merchantId, from, to, bucket: 'day' }, p.seriesSchema, signal),
  teamMe: (signal?: AbortSignal) => query('merchantOps.team.me', {}, p.teamMeSchema, signal),
  haltStatus: (merchantId: string, signal?: AbortSignal) => query('payHalts.status', { merchantId }, p.haltStatusSchema, signal),
});
