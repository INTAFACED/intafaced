import type { z } from 'zod';
import {
  type BANK_SUPPORTED_ASSET_ACTIONS,
  type BANK_SUPPORTED_ASSET_STATES,
  type bankSupportedAssetSchema,
} from '@intafaced/contracts/bank-money-room';
import { useSession } from '../session';
import { useResource } from '../../shared/resource';
import type { ApiClient, ApiResult } from '../../shared/api';
import { BANK_ASSETS_LIST } from '@intafaced/contracts/bank-assets-procedures';
import { type ProcedureOutput } from '@intafaced/contracts/procedure';

/** svc-bank `assets.list` (W-balances-05), read with the schema in `@intafaced/contracts/bank-money-room`. */
export {
  BANK_SUPPORTED_ASSET_ACTIONS as SUPPORTED_ASSET_ACTIONS,
  BANK_SUPPORTED_ASSET_STATES as SUPPORTED_ASSET_STATES,
  bankSupportedAssetSchema as supportedAssetSchema,
  bankSupportedAssetsSchema as supportedAssetsSchema,
} from '@intafaced/contracts/bank-money-room';
export type SupportedAsset = z.infer<typeof bankSupportedAssetSchema>;
export type SupportedAssetAction = (typeof BANK_SUPPORTED_ASSET_ACTIONS)[number];
export type SupportedAssetState = (typeof BANK_SUPPORTED_ASSET_STATES)[number];
export type SupportedAssets = ProcedureOutput<typeof BANK_ASSETS_LIST>;

export function createSupportedAssetReads(api: ApiClient) {
  return {
    list: (signal?: AbortSignal): Promise<ApiResult<SupportedAssets>> => api.call(BANK_ASSETS_LIST, undefined, { signal }),
  };
}

export function useSupportedAssets() {
  const { api, userId } = useSession();
  return useResource<SupportedAssets>(async (signal) => createSupportedAssetReads(api).list(signal), `${userId}:supported-assets`);
}
