import type { DepositCatalogue } from './deposit-reads';

/** `/uc/recharge?asset=USDT&network=tron`: what the address asked for. Either part may be missing; nothing is chosen for the person. */
export type DepositLink = { asset: string | null; network: string | null };

export function readDepositLink(search: string): DepositLink {
  const params = new URLSearchParams(search);
  const pick = (name: string) => {
    const value = params.get(name)?.trim();
    return value ? value.slice(0, 64) : null;
  };
  return { asset: pick('asset'), network: pick('network') };
}

/** The address that opens the deposit room on one asset, and on one network of it when that is given. */
export function depositHref(asset?: string | null, network?: string | null): string {
  const params = new URLSearchParams();
  if (asset) params.set('asset', asset);
  if (asset && network) params.set('network', network);
  const query = params.toString();
  return query ? `/uc/recharge?${query}` : '/uc/recharge';
}

export type DepositLinkResult =
  | { status: 'none' }
  | { status: 'ok'; asset: string; network: string }
  | {
      status: 'refused';
      code: 'bank.deposit_asset_unpublished' | 'bank.deposit_network_unpublished';
      asset: string;
      network: string | null;
    };

/**
 * Matches the link against what custody publishes. Case is ignored for the match and the published spelling is returned.
 * An asset or network that is not published is refused with its typed code and chooses nothing. Without a published list
 * (custody not set, or still loading) the link is not judged.
 */
export function resolveDepositLink(link: DepositLink, catalogue: DepositCatalogue | null): DepositLinkResult {
  if (!link.asset || !catalogue) return { status: 'none' };
  const wanted = link.asset.toLowerCase();
  const row = catalogue.assets.find((entry) => entry.assetId.toLowerCase() === wanted);
  if (!row) return { status: 'refused', code: 'bank.deposit_asset_unpublished', asset: link.asset, network: link.network };
  if (!link.network) return { status: 'ok', asset: row.assetId, network: '' };
  const network = row.networks.find((entry) => entry.id.toLowerCase() === link.network!.toLowerCase());
  if (!network) return { status: 'refused', code: 'bank.deposit_network_unpublished', asset: row.assetId, network: link.network };
  return { status: 'ok', asset: row.assetId, network: network.id };
}
