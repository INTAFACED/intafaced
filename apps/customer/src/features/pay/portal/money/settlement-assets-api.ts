import { z } from 'zod';
import { amount, asset } from '../../schemas';
import { registerRefusals } from '../refusal';
import type { PortalTools } from '../api-tools';
import { mc } from './copy';

/**
 * Browser projection of svc-pay `merchantMetrics.settlementAssets` (packages/contracts/src/merchant-metrics.ts): each
 * asset the business can settle in, with its two ledger figures. A zero here is the ledger's answer, never one the page
 * fills in. Money stays a decimal string.
 */
export const settlementAssetsSchema = z.object({
  merchantId: z.string(),
  asOf: z.string().datetime({ offset: true }),
  assets: z.array(z.object({ assetCode: asset, clearing: amount, available: amount })).min(1),
});
export type SettlementAssets = z.infer<typeof settlementAssetsSchema>;

/** The owner has not set which assets a business settles in: the list stays blank and the room says so. */
export const SETTLEMENT_ASSETS_UNSET = 'pay.settlement_assets_unset';
registerRefusals({ [SETTLEMENT_ASSETS_UNSET]: () => mc.t('rSettlementAssetsUnset') });

export const settlementAssetsApi = ({ query }: PortalTools) => ({
  settlementAssets: (merchantId: string, signal?: AbortSignal) =>
    query('merchantMetrics.settlementAssets', { merchantId }, settlementAssetsSchema, signal),
});
