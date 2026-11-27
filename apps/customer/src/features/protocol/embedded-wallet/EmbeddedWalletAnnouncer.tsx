import { useMemo, useSyncExternalStore } from 'react';
import type { ProtocolEmbeddedWalletProvider, ProtocolEmbeddedWalletRecord } from '@intafaced/contracts/protocol-embedded-wallet';
import { useEventListener, useTimeout } from '../../../shared/outside';
import { useResource } from '../../../shared/resource';
import { useSession } from '../../session';
import { createEmbeddedWalletApi } from './embedded-wallet-api';
import { embeddedWalletCopy } from './embedded-wallet-copy';
import { announce, embeddedProvider, EMBEDDED_WALLET_ICON, EMBEDDED_WALLET_RDNS, type Announced } from './embedded-provider';
import { embeddedWalletClient } from './provider-client';

/**
 * The person's own embedded wallet, offered to every room that looks for a browser wallet (EIP-6963): while the signed-in
 * person has one, this page answers `eip6963:requestProvider` with it, named "INTAFACED wallet" (TEST on a TEST
 * provider). Mounted once for the app, so a room that opens later finds it at once and a connected wallet comes back
 * without a prompt. svc-protocol is asked only for its record of the wallet, the same call the wallet room makes.
 */

// The room that makes the wallet says so here, so the announcement follows without a reload.
let madeCount = 0;
const madeListeners = new Set<() => void>();
export function noteEmbeddedWalletMade(): void {
  madeCount += 1;
  for (const listener of madeListeners) listener();
}
const subscribeMade = (listener: () => void) => {
  madeListeners.add(listener);
  return () => madeListeners.delete(listener);
};
const readMade = () => madeCount;

// One provider per wallet for the page's life, so its chain and its connection carry across rooms.
const providers = new Map<string, Announced>();
const connectedKey = (walletId: string) => `if.embedded-wallet.connected.${walletId}`;
function wasConnected(walletId: string): boolean {
  try {
    return sessionStorage.getItem(connectedKey(walletId)) === '1';
  } catch {
    return false;
  }
}
function rememberConnected(walletId: string): void {
  try {
    sessionStorage.setItem(connectedKey(walletId), '1');
  } catch {
    /* blocked storage: the page keeps it */
  }
}

/** The announcement for this wallet, or null when the page has no client that can reach its provider. */
export function announcedWallet(
  provider: ProtocolEmbeddedWalletProvider,
  wallet: ProtocolEmbeddedWalletRecord,
  name: string,
  makeClient = embeddedWalletClient,
): Announced | null {
  const key = `${provider.id}:${provider.test}:${wallet.providerWalletId}:${wallet.address.toLowerCase()}:${name}`;
  const kept = providers.get(key);
  if (kept) return kept;
  // The owner's provider signs only for the wallet it is given (its sub-organisation and address): without it, every
  // signature the page asks for is refused.
  const client = makeClient(provider, { address: wallet.address, providerWalletId: wallet.providerWalletId });
  if (!client) return null;
  const walletId = wallet.providerWalletId;
  const made: Announced = {
    info: { uuid: crypto.randomUUID(), name, icon: EMBEDDED_WALLET_ICON, rdns: EMBEDDED_WALLET_RDNS },
    provider: embeddedProvider({
      client,
      walletId,
      address: wallet.address,
      authorised: wasConnected(walletId),
      onAuthorised: () => rememberConnected(walletId),
    }),
  };
  providers.set(key, made);
  return made;
}

export function EmbeddedWalletAnnouncer() {
  const { t } = embeddedWalletCopy.useCopy();
  const { api, userId } = useSession();
  const made = useSyncExternalStore(subscribeMade, readMade, readMade);
  const embedded = useMemo(() => createEmbeddedWalletApi(api), [api]);
  const status = useResource(
    (signal) => (userId ? embedded.status(signal) : Promise.resolve({ ok: true as const, data: null })),
    `embedded-wallet-announce:${userId ?? 'out'}:${made}`,
  );
  const read = status.resource.status === 'ready' ? status.resource.data : null;
  const provider = read?.provider ?? null;
  const wallet = read?.wallet ?? null;
  const name = provider?.test || wallet?.test ? t('announceNameTest') : t('announceName');
  const announced = provider && wallet ? announcedWallet(provider, wallet, name) : null;
  const target = typeof window === 'undefined' ? null : window;
  useEventListener(target, 'eip6963:requestProvider', () => {
    if (announced && target) announce(target, announced);
  });
  // A wallet announces itself once it is there too, for a room that asked before it was (EIP-6963).
  useTimeout(
    () => {
      if (announced && target) announce(target, announced);
    },
    announced ? 0 : null,
    announced,
  );
  return null;
}
