/**
 * Where a trading session's key is kept on this device (J-wallet-22 #8, slice D-venue-09;
 * features/protocol/embedded-wallet/trading-session.ts): this tab's sessionStorage, one entry per person.
 *
 * Signing out ends the session for this device: every such key is dropped from the tab at once (session-restore.ts
 * `signOut`), so nothing on the device can sign with it after the sign-out, whichever room was open. On the venue the
 * key ends at its expiry, at End trading session (the owner's `revoke_agent`), or when the next session's key replaces
 * it; the next sign-in always starts a new key.
 */
export const DEVICE_SESSION_KEY_PREFIX = 'intafaced.venue-session-key:';

type Store = Pick<globalThis.Storage, 'length' | 'key' | 'removeItem'>;

function tabStore(): Store | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/** Drop every trading-session key this tab holds. */
export function forgetDeviceSessionKeys(store: Store | null = tabStore()): void {
  if (!store) return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < store.length; i += 1) {
      const k = store.key(i);
      if (k?.startsWith(DEVICE_SESSION_KEY_PREFIX)) keys.push(k);
    }
    for (const k of keys) store.removeItem(k);
  } catch {
    /* a tab that cannot read its storage holds nothing there */
  }
}
