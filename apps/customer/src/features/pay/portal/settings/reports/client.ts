import type { SettingsBTools } from '../b-client';
import { tolerantPage } from '../b-shared';
import * as s from './schemas';

export type ExportFilter = { kind?: string; status?: string; from?: string; to?: string; search?: string };

export const reportsApi = ({ query, mutate }: SettingsBTools) => ({
  reportJobs: (cursor: string | undefined, f: ExportFilter, signal?: AbortSignal) =>
    query(
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
  reportRequest: (input: {
    requestId: string;
    kind: string;
    filters: { from?: string; to?: string; status?: string; assetId?: string };
    columns?: string[];
  }) => mutate('merchantOps.exports.create', input, s.exportJobSchema),
  reportDownload: (jobId: string) => query('merchantOps.exports.download', { jobId }, s.exportDownloadSchema),
  reportDelete: (jobId: string) => mutate('merchantOps.exports.expire', { jobId }, s.exportJobSchema),
  /** Names for "requested by": the team list gives a label per person. */
  reportPeople: (signal?: AbortSignal) => query('merchantOps.team.list', { limit: 100 }, tolerantPage(s.memberLabelSchema), signal),
});
