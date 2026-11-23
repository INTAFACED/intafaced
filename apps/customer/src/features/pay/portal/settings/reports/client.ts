import type { SettingsBTools } from '../b-client';
import { pagedResult } from '../../ui/page';
import * as s from './schemas';
import type { ProcedureInput } from '@intafaced/contracts/procedure';
import {
  PAY_MERCHANT_OPS_EXPORTS_CREATE,
  PAY_MERCHANT_OPS_EXPORTS_DOWNLOAD,
  PAY_MERCHANT_OPS_EXPORTS_LIST,
  PAY_MERCHANT_OPS_TEAM_LIST,
} from '@intafaced/contracts/pay-merchant-ops-procedures';

type ExportListInput = ProcedureInput<typeof PAY_MERCHANT_OPS_EXPORTS_LIST>;

export type ExportFilter = { kind?: string; status?: string; from?: string; to?: string; search?: string };

export const reportsApi = ({ mutate, mutateRecord, queryRecord }: SettingsBTools) => ({
  reportJobs: async (cursor: string | undefined, f: ExportFilter, signal?: AbortSignal) =>
    pagedResult(
      await queryRecord(
        PAY_MERCHANT_OPS_EXPORTS_LIST,
        {
          limit: 25,
          ...(cursor ? { cursor } : {}),
          // The page's filter text is sent as before; the service checks it against its own list and refuses any other.
          ...(f.kind ? { kind: f.kind as ExportListInput['kind'] } : {}),
          ...(f.status ? { status: f.status as ExportListInput['status'] } : {}),
          ...(f.from ? { from: f.from } : {}),
          ...(f.to ? { to: f.to } : {}),
          ...(f.search ? { search: f.search } : {}),
        },
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
  reportPeople: async (signal?: AbortSignal) => pagedResult(await queryRecord(PAY_MERCHANT_OPS_TEAM_LIST, { limit: 100 }, signal)),
});
