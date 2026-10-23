import { assetAllows, type RegistryAsset } from '@intafaced/contracts';
import { BankError } from '../errors.js';

/**
 * WHICH ASSET MAY BE SENT ON WHICH NETWORK (W-withdraw-08 on W-balances-05).
 *
 * The address book used to accept any network name that looked like one, so a saved entry could name a network
 * nothing will ever send on. The one list of assets, networks and what each may be used for is svc-ledger's registry
 * (`assets.list`); this reads it and nothing else. Nothing here is defaulted: an asset the owner has not published, or
 * one that does not allow withdrawals, offers no network, and a network not listed for the asset refuses.
 */

/** What the address book needs from one registry row. */
export interface WithdrawAsset {
  assetId: string;
  precision: number;
  networks: Array<{ networkId: string; label: string }>;
  defaultNetworkId: string | null;
}

/** The registry, as svc-bank reads it. A failure is thrown: "no networks" and "could not ask" must not look alike. */
export interface WithdrawNetworkSource {
  /** Every published asset that allows `withdraw` and is active. */
  withdrawable(): Promise<RegistryAsset[]>;
}

/** The ledger's registry could not be read, or this deployment has no route to it. Nothing was saved. */
export const ASSET_REGISTRY_UNAVAILABLE = 'bank.asset_registry_unavailable' as const;
/** The asset does not allow withdrawals, or the network is not one listed for it. Nothing was saved. */
export const WITHDRAW_NETWORK_UNSUPPORTED = 'bank.withdraw_network_unsupported' as const;

async function read(source: WithdrawNetworkSource | null): Promise<RegistryAsset[]> {
  if (!source) {
    throw new BankError('The list of supported assets and networks is not connected', ASSET_REGISTRY_UNAVAILABLE);
  }
  try {
    return await source.withdrawable();
  } catch {
    // A fixed sentence: the ledger's own error wording is not the customer's to read.
    throw new BankError('The list of supported assets and networks could not be read. Try again shortly', ASSET_REGISTRY_UNAVAILABLE);
  }
}

/** The assets a person may save a withdrawal address for, each with its networks, in the registry's order. */
export async function listWithdrawNetworks(source: WithdrawNetworkSource | null): Promise<WithdrawAsset[]> {
  const assets = await read(source);
  return assets
    .filter((asset) => assetAllows(asset, 'withdraw') && asset.networks.length > 0)
    .map((asset) => ({
      assetId: asset.id,
      precision: asset.precision,
      networks: asset.networks.map((n) => ({ networkId: n.networkId, label: n.label })),
      defaultNetworkId: asset.defaultNetworkId,
    }));
}

/** Refuses unless the registry lists `network` for `assetId` and the asset allows withdrawals now. */
export async function assertWithdrawNetwork(source: WithdrawNetworkSource | null, assetId: string, network: string): Promise<void> {
  const asset = (await listWithdrawNetworks(source)).find((a) => a.assetId === assetId);
  if (!asset) {
    throw new BankError(`${assetId} cannot be withdrawn right now, so no address can be saved for it`, WITHDRAW_NETWORK_UNSUPPORTED);
  }
  if (!asset.networks.some((n) => n.networkId === network)) {
    throw new BankError(
      `${assetId} is not sent on ${network}. Choose one of: ${asset.networks.map((n) => n.label).join(', ')}`,
      WITHDRAW_NETWORK_UNSUPPORTED,
    );
  }
}

/** A fixed list, for tests (like `memoryWithdrawDestinations`). Production reads svc-ledger (`createLedgerAssetRegistry`). */
export function memoryWithdrawNetworks(assets: RegistryAsset[]): WithdrawNetworkSource {
  return { withdrawable: async () => assets.filter((asset) => assetAllows(asset, 'withdraw')) };
}
