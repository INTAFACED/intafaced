import type { SettingsBTools } from '../b-client';
import { tolerantPage } from '../b-shared';
import { pagedResult } from '../../ui/page';
import * as s from './schemas';
import { PAY_MERCHANT_OPS_EXPORTS_CREATE, PAY_MERCHANT_OPS_EXPORTS_DOWNLOAD } from '@intafaced/contracts/pay-merchant-ops-procedures';

export type ExportFilter = { kind?: string; status?: string; from?: string; to?: string; search?: string };

export const reportsApi = ({ query, mutate, mutateRecord, queryRecord }: SettingsBTools) => ({
  reportJobs: async (cursor: string | undefined, f: ExportFilter, signal?: AbortSignal) =>
    pagedResult(
      await query(
        'merchantOps.exports.list',
        {
          limit: 25,
          ...(cursor ? { cursor } : {}),
          ...(f.kind ? { kind: f.kind } : {}),
          ...(f.status ? { status: f.status } : {}),
          ...(f.from ? { from: f.from } : {}),
          ...(f.to ? { to: f.to } : {}),
          ...(f.search ? { search: f.search } : {}),
        },
        tolerantPage(s.exportJobSchema),
        signal,
      ),
    ),
  reportRequest: (input: {
    requestId: string;
    kind: s.ExportKind;
    filters: { from?: string; to?: string; status?: string; assetId?: string };
    columns?: string[];
  }) => mutateRecord(PAY_MERCHANT_OPS_EXPORTS_CREATE, input),
  reportDownload: (jobId: string) => queryRecord(PAY_MERCHANT_OPS_EXPORTS_DOWNLOAD, { jobId }),
  reportDelete: (jobId: string) => mutate('merchantOps.exports.expire', { jobId }, s.exportJobSchema),
  /** Names for "requested by": the team list gives a label per person. */
  reportPeople: async (signal?: AbortSignal) =>
    pagedResult(await query('merchantOps.team.list', { limit: 100 }, tolerantPage(s.memberLabelSchema), signal)),
});
