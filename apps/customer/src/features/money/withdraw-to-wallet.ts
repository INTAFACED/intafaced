import type { Destination } from './contracts';

/**
 * "Withdraw to my Web3 wallet" (D-bridge-chain-02): `/uc/withdraw?to=wallet` fills the destination with the browser
 * wallet's connected account. The fill is a convenience only. Money still goes out through the normal withdrawal door, to a
 * saved address whose approval and cooling-off the bank checks, after a fresh step-up; nothing here admits a typed address.
 */

/** Whether the address bar asks for the wallet fill: exactly one `to=wallet`. */
export function asksForWallet(search: string): boolean {
  const values = new URLSearchParams(search).getAll('to');
  return values.length === 1 && values[0] === 'wallet';
}

/** The refusal code a wallet fill carries when no wallet is connected, or the one that filled it went away. */
export const WALLET_NOT_CONNECTED = 'wallet.not_connected';

export type WalletFill =
  /** Not asked for: the form is the normal one. */
  | { state: 'off' }
  /** The wallet is being asked for its account. */
  | { state: 'checking' }
  /** No wallet is connected: nothing is filled. */
  | { state: 'none'; code: typeof WALLET_NOT_CONNECTED }
  /** The connected account, and the chain the wallet reports (null when it reported none). */
  | { state: 'filled'; address: string; chainId: number | null };

/** What the wallet fill holds now, from the wallet connection's own state. An account that is not a 0x address fills nothing. */
export function walletFill(
  asked: boolean,
  wallet: { status: 'disconnected' | 'connecting' | 'connected'; address: string | null; chainId: number | null },
): WalletFill {
  if (!asked) return { state: 'off' };
  if (wallet.status === 'connecting') return { state: 'checking' };
  if (wallet.status === 'connected' && wallet.address && /^0x[0-9a-fA-F]{40}$/.test(wallet.address))
    return { state: 'filled', address: wallet.address, chainId: wallet.chainId };
  return { state: 'none', code: WALLET_NOT_CONNECTED };
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * The withdrawal network to fill for the wallet's address: the one network the person saved this address on for this
 * asset, when it is one the asset list opens. The bank's network list names no chain id, so the wallet's own chain is
 * never mapped to a network here; with no saved entry, or entries on more than one network, nothing is filled (null).
 */
export function walletSavedNetwork(
  book: readonly Destination[],
  assetId: string,
  address: string,
  offered: readonly { networkId: string }[],
): string | null {
  const networks = new Set(
    book
      .filter((row) => row.kind === 'crypto' && row.assetId === assetId && row.state !== 'archived' && same(row.ref, address))
      .map((row) => row.network ?? ''),
  );
  if (networks.size !== 1) return null;
  const [only] = networks;
  return only && offered.some((entry) => entry.networkId === only) ? only : null;
}

/**
 * Whether a wallet fill that was in use has gone: it held an address, and now it holds none or another account. A form
 * confirming a send that the fill chose closes it, and the destination is cleared (`wallet.not_connected`).
 */
export function walletGone(before: WalletFill, now: WalletFill): boolean {
  if (before.state !== 'filled') return false;
  return now.state !== 'filled' || !same(before.address, now.address);
}
