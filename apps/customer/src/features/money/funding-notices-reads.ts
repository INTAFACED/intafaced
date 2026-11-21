import type { z } from 'zod';
import { notifyFundingNoticeSchema, notifyFundingNoticesSchema } from '@intafaced/contracts/notify-public-notices';
import type { ApiClient, ApiResult } from '../../shared/api';

/** The stages a funding incident goes through, as svc-notify names them. Only the closing entry reads `resolved`. */
export { NOTIFY_FUNDING_PHASES as FUNDING_PHASES } from '@intafaced/contracts/notify-public-notices';
export type FundingPhase = NonNullable<FundingNotice['phase']>;
/** The public notice entry, with the pair and stage a funding notice carries. */
export type FundingNotice = z.infer<typeof notifyFundingNoticeSchema>;
/** Each open incident on this pair: its first entry (what happened, when it started) and its newest (where it stands now). */
export type FundingNotices = z.infer<typeof notifyFundingNoticesSchema>;

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
): Promise<ApiResult<FundingNotices>> =>
  api.query('notify', 'notify.fundingNotices', { asset, network }, notifyFundingNoticesSchema, { signal });
