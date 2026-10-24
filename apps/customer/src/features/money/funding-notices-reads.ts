// hand-declared-ok: svc-notify's `notify.fundingNotices` output is declared inline in its router, not in a browser-safe @intafaced/contracts export; this extends the entry shape that mirrors its notice output.
import { z } from 'zod';
import type { ApiClient, ApiResult } from '../../shared/api';
import { entrySchema } from '../developers/developers-api';

/** The stages a funding incident goes through, as svc-notify names them. Only the closing entry reads `resolved`. */
export const FUNDING_PHASES = ['investigating', 'identified', 'update', 'monitoring', 'resolved'] as const;
export type FundingPhase = (typeof FUNDING_PHASES)[number];

/** The public notice entry, with the pair and stage a funding notice carries. */
const fundingNoticeSchema = entrySchema.extend({
  asset: z.string().nullable(),
  network: z.string().nullable(),
  phase: z.enum(FUNDING_PHASES).nullable(),
});
export type FundingNotice = z.infer<typeof fundingNoticeSchema>;

const fundingNoticesSchema = z.object({
  asset: z.string(),
  network: z.string(),
  /** Each open incident on this pair: its first entry (what happened, when it started) and its newest (where it stands now). */
  incidents: z.array(z.object({ root: fundingNoticeSchema, latest: fundingNoticeSchema })),
  maintenance: z.array(fundingNoticeSchema),
});
export type FundingNotices = z.infer<typeof fundingNoticesSchema>;

/** The registry's spelling of an asset and a network slug, as svc-notify scopes a notice. No notice can name another pair. */
const ASSET = /^[A-Z0-9]{2,20}$/;
const NETWORK = /^[a-z0-9][a-z0-9-]{1,39}$/;
export const isNoticePair = (asset: string, network: string) => ASSET.test(asset) && NETWORK.test(network);

/**
 * Open funding incidents and maintenance the founders published for one asset on one network. Public, so it works signed
 * out. Another network of the same asset is never included.
 */
export const readFundingNotices = (
  api: ApiClient,
  asset: string,
  network: string,
  signal?: AbortSignal,
): Promise<ApiResult<FundingNotices>> => api.query('notify', 'notify.fundingNotices', { asset, network }, fundingNoticesSchema, { signal });
