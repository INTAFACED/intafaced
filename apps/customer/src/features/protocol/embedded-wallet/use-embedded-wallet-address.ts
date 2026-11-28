import { useMemo } from 'react';
import { useResource } from '../../../shared/resource';
import { useSession } from '../../session';
import { createEmbeddedWalletApi } from './embedded-wallet-api';

/**
 * The address of the signed-in person's INTAFACED wallet, as svc-protocol records it, lowercase; null while it is read,
 * when they have made none, or when the record can't be read. For a read by address only: it never connects the wallet
 * and never signs.
 */
export function useEmbeddedWalletAddress(): string | null {
  const { api, userId } = useSession();
  const embedded = useMemo(() => createEmbeddedWalletApi(api), [api]);
  const { resource } = useResource(
    (signal) => (userId ? embedded.status(signal) : Promise.resolve({ ok: true as const, data: null })),
    `embedded-wallet-address:${userId ?? 'out'}`,
  );
  const address = resource.status === 'ready' ? resource.data?.wallet?.address : null;
  return address ? address.toLowerCase() : null;
}
