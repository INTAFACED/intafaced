import type { z } from 'zod';
import { merchantSettlementAssetsSchema } from '@intafaced/contracts/merchant-metrics';
import { registerRefusals } from '../refusal';
import type { PortalTools } from '../api-tools';
import { mc } from './copy';

/**
 * svc-pay `merchantMetrics.settlementAssets`, read with the contract's own schema: each asset the business can settle in,
 * with its two ledger figures. A zero here is the ledger's answer, never one the page fills in. Money stays a decimal
 * string.
 */
export const settlementAssetsSchema = merchantSettlementAssetsSchema;
export type SettlementAssets = z.infer<typeof settlementAssetsSchema>;

/** The owner has not set which assets a business settles in: the list stays blank and the room says so. */
export const SETTLEMENT_ASSETS_UNSET = 'pay.settlement_assets_unset';
registerRefusals({ [SETTLEMENT_ASSETS_UNSET]: () => mc.t('rSettlementAssetsUnset') });

export const settlementAssetsApi = ({ query }: PortalTools) => ({
  settlementAssets: (merchantId: string, signal?: AbortSignal) =>
    query('merchantMetrics.settlementAssets', { merchantId }, settlementAssetsSchema, signal),
});
