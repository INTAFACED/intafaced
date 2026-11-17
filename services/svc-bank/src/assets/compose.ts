import type { BankRoot } from '../bank-root.js';
import { listSupportedAssets, type SupportedAssetView } from './supported-assets.js';

/** The supported asset list. An area of svc-bank (`area-chain.ts`). */
export interface AssetsServices {
  /** W-balances-05: svc-ledger's supported asset and network list, every state, as customers read it. */
  readonly supportedAssets: { list(): Promise<SupportedAssetView[]> };
}

export function composeAssetsArea(root: BankRoot): AssetsServices {
  return { supportedAssets: { list: () => listSupportedAssets(root.assetRegistry) } };
}
