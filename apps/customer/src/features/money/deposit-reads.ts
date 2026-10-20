// hand-declared-ok: svc-bank's `bank.deposits.assets` and `bank.deposits.address` outputs are declared inline in its router, not in a browser-safe @intafaced/contracts export; moving them there is a contracts follow-up.
import { z } from 'zod';
import { useSession } from '../session/session';
import { useResource } from '../../shared/resource';
import { decimalSchema } from '../../shared/money';
import type { ApiClient, ApiResult } from '../../shared/api';

/** What custody says can be paid in. Every number is the service's own decimal or count; nothing here is typed by hand. */
export const depositNetworkSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  minimumDeposit: decimalSchema,
  confirmationsRequired: z.number().int().nonnegative(),
  estimatedArrivalMinutes: z.number().int().nonnegative(),
});
export type DepositNetworkView = z.infer<typeof depositNetworkSchema>;

export const depositCatalogueSchema = z.object({
  assets: z.array(z.object({ assetId: z.string().min(1), networks: z.array(depositNetworkSchema) })),
});
export type DepositCatalogue = z.infer<typeof depositCatalogueSchema>;

export const depositAddressSchema = z.object({
  assetId: z.string().min(1),
  networkId: z.string().min(1),
  address: z.string().min(1),
  memo: z.string().nullable(),
  qrPayload: z.string().nullable(),
});
export type DepositAddressView = z.infer<typeof depositAddressSchema>;

export function createDepositReads(api: ApiClient) {
  return {
    assets: (signal?: AbortSignal): Promise<ApiResult<DepositCatalogue>> =>
      api.query('bank', 'deposits.assets', undefined, depositCatalogueSchema, { signal }),
    /** The person's own address for one asset on one network. The same call returns the same address. */
    async address(assetId: string, networkId: string): Promise<ApiResult<DepositAddressView>> {
      const result = await api.mutate('bank', 'deposits.address', { assetId, networkId }, depositAddressSchema);
      // An answer for a different pair is never shown as the one that was asked for.
      return result.ok && (result.data.assetId !== assetId || result.data.networkId !== networkId)
        ? {
            ok: false,
            reason: 'invalid_response',
            code: 'bank.deposit_catalogue_invalid',
            message: 'The address did not match the request.',
          }
        : result;
    },
  };
}

export function useDepositCatalogue() {
  const { api, userId } = useSession();
  return useResource<DepositCatalogue>(async (signal) => createDepositReads(api).assets(signal), `${userId}:deposit-catalogue`);
}
