import { assetAllows, type RegistryAsset } from '@intafaced/contracts';
import { BankError } from '../errors.js';
import { ASSET_REGISTRY_UNAVAILABLE } from '../ramps/withdraw-networks.js';

/**
 * THE SUPPORTED ASSET AND NETWORK LIST, AS CUSTOMERS SEE IT (W-balances-05, J-wallet-01 #5).
 *
 * svc-ledger's registry is the one list of assets, their networks, their precision and what each may be used for. The
 * address book reads it for withdrawals (`withdraw-networks.ts`) and the deposit catalogue is narrowed to it
 * (`deposit-service.ts`); this hands the same rows to the customer, every state included, so a retired asset stays
 * listed and the history that names it still resolves. Nothing is defaulted: a row the owner has not published is not
 * in the ledger's list, and an unreadable registry refuses rather than answering with an empty list.
 */

/** Every published registry row, any state. A failure is thrown: "nothing is supported" and "could not ask" must not look alike. */
export interface AssetRegistryReads {
  listed(): Promise<RegistryAsset[]>;
}

/** One row as the customer reads it: the registry row without its edit bookkeeping. */
export interface SupportedAssetView {
  assetId: string;
  kind: RegistryAsset['kind'];
  precision: number;
  networks: Array<{ networkId: string; label: string }>;
  defaultNetworkId: string | null;
  allowedActions: RegistryAsset['allowedActions'];
  state: RegistryAsset['state'];
}

/** The registry's rows, or the one refusal that says it could not be read. */
export async function readRegistry(source: AssetRegistryReads | null): Promise<RegistryAsset[]> {
  if (!source) {
    throw new BankError('The list of supported assets and networks is not connected', ASSET_REGISTRY_UNAVAILABLE);
  }
  try {
    return await source.listed();
  } catch {
    // A fixed sentence: the ledger's own error wording is not the customer's to read.
    throw new BankError('The list of supported assets and networks could not be read. Try again shortly', ASSET_REGISTRY_UNAVAILABLE);
  }
}

/** Every published asset with its networks, precision, actions and state, in the registry's order. */
export async function listSupportedAssets(source: AssetRegistryReads | null): Promise<SupportedAssetView[]> {
  return (await readRegistry(source)).map((asset) => ({
    assetId: asset.id,
    kind: asset.kind,
    precision: asset.precision,
    networks: asset.networks.map((n) => ({ networkId: n.networkId, label: n.label })),
    defaultNetworkId: asset.defaultNetworkId,
    allowedActions: [...asset.allowedActions],
    state: asset.state,
  }));
}

/** Whether the registry lets `assetId` be paid in on `networkId` now: active, deposits allowed, the network listed. */
export function registryAllowsDeposit(registry: readonly RegistryAsset[], assetId: string, networkId: string): boolean {
  const asset = registry.find((row) => row.id === assetId);
  return !!asset && assetAllows(asset, 'deposit') && asset.networks.some((n) => n.networkId === networkId);
}

/** A fixed list, for tests (like `memoryWithdrawNetworks`). Production reads svc-ledger (`createLedgerAssetRegistry`). */
export function memoryAssetRegistry(assets: RegistryAsset[]): AssetRegistryReads {
  return { listed: async () => assets };
}
