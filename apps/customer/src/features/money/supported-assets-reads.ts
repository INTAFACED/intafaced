// hand-declared-ok: svc-bank's `bank.assets.list` mirrors packages/contracts/src/asset-registry.ts, whose module also hashes edits with node:crypto, so it has no browser-safe export yet.
import { z } from 'zod';
import { useSession } from '../session/session';
import { useResource } from '../../shared/resource';
import type { ApiClient, ApiResult } from '../../shared/api';

/** Mirrors the registry's own enums (`ASSET_ACTIONS`, `ASSET_STATES`, `REGISTRY_ASSET_KINDS`). */
export const SUPPORTED_ASSET_ACTIONS = ['deposit', 'withdraw', 'trade', 'transfer'] as const;
export const SUPPORTED_ASSET_STATES = ['active', 'halted', 'retired'] as const;

/** One row of svc-ledger's supported asset and network list (W-balances-05), every state, as svc-bank hands it on. */
export const supportedAssetSchema = z.object({
  assetId: z.string().regex(/^[A-Z0-9]{1,16}$/),
  kind: z.enum(['crypto', 'fiat', 'native', 'commodity']),
  precision: z.number().int().min(0).max(18),
  networks: z.array(z.object({ networkId: z.string().min(1), label: z.string().min(1) })),
  defaultNetworkId: z.string().min(1).nullable(),
  allowedActions: z.array(z.enum(SUPPORTED_ASSET_ACTIONS)),
  state: z.enum(SUPPORTED_ASSET_STATES),
});
export type SupportedAsset = z.infer<typeof supportedAssetSchema>;
export type SupportedAssetAction = (typeof SUPPORTED_ASSET_ACTIONS)[number];
export type SupportedAssetState = (typeof SUPPORTED_ASSET_STATES)[number];

export const supportedAssetsSchema = z.object({ assets: z.array(supportedAssetSchema) });
export type SupportedAssets = z.infer<typeof supportedAssetsSchema>;

export function createSupportedAssetReads(api: ApiClient) {
  return {
    list: (signal?: AbortSignal): Promise<ApiResult<SupportedAssets>> =>
      api.query('bank', 'assets.list', undefined, supportedAssetsSchema, { signal }),
  };
}

export function useSupportedAssets() {
  const { api, userId } = useSession();
  return useResource<SupportedAssets>(async (signal) => createSupportedAssetReads(api).list(signal), `${userId}:supported-assets`);
}
