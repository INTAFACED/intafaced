import { useResource } from '../../../../shared/resource';
import type { PortalApi } from '../api';
import { assetsOf } from '../model';

/** The asset every new invoice and link starts on. */
export const DEFAULT_ASSET = 'USDT';

/**
 * The assets a merchant can pick for an invoice or a payment link: the ones their account already deals in (read from
 * the last 30 days of totals), plus the one currently chosen so a draft never loses its value. The default is always
 * offered. Nothing here is invented: an asset the account has never touched simply isn't listed until it appears.
 */
export function assetChoices(known: readonly string[], current = ''): string[] {
  return [...new Set([DEFAULT_ASSET, ...known, ...(current ? [current] : [])])].sort();
}

export function useAssetChoices(portal: PortalApi | undefined, merchantId: string | undefined, current = ''): string[] {
  const snapshot = useResource(
    (signal) =>
      portal && merchantId
        ? portal.snapshot(merchantId, 'rolling_30d', signal)
        : Promise.resolve({ ok: false as const, reason: 'not_supported' as const, message: '' }),
    `portal:asset-choices:${merchantId ?? 'none'}`,
  );
  return assetChoices(snapshot.resource.status === 'ready' ? assetsOf(snapshot.resource.data) : [], current);
}
