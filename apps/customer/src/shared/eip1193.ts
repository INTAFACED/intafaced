/**
 * A browser wallet as plain EIP-1193 / EIP-6963 calls: finding the wallets a page can see and reading what they answer.
 * Shared because sign-in (features/session) and the Web3 rooms (features/protocol) both talk to the wallet. Nothing here holds
 * a key; every signature is the wallet's own.
 */
export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
}
export interface WalletInfo {
  uuid: string;
  name: string;
  icon: string;
  rdns: string;
}
export interface DiscoveredWallet {
  info: WalletInfo;
  provider: Eip1193Provider;
}

const ANNOUNCE = 'eip6963:announceProvider';
const REQUEST = 'eip6963:requestProvider';

/** Wallets announce themselves on request (EIP-6963). Returns what has announced so far through `onChange`, and a stop function. */
export function discoverWallets(
  target: Pick<Window, 'addEventListener' | 'removeEventListener' | 'dispatchEvent'>,
  onChange: (wallets: DiscoveredWallet[]) => void,
): () => void {
  const found = new Map<string, DiscoveredWallet>();
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<{ info?: Partial<WalletInfo>; provider?: Eip1193Provider }>).detail;
    const info = detail?.info;
    if (!info || typeof info.uuid !== 'string' || typeof info.name !== 'string' || typeof info.rdns !== 'string' || !detail.provider)
      return;
    // An icon is only ever shown as an image source, and only when it is an inline image.
    const icon = typeof info.icon === 'string' && info.icon.startsWith('data:image/') ? info.icon : '';
    found.set(info.uuid, { info: { uuid: info.uuid, name: info.name, rdns: info.rdns, icon }, provider: detail.provider });
    onChange([...found.values()]);
  };
  target.addEventListener(ANNOUNCE, listener);
  target.dispatchEvent(new Event(REQUEST));
  return () => target.removeEventListener(ANNOUNCE, listener);
}

/** `0x14a34` becomes 84532; anything that is not a hex quantity becomes null, never 0. */
export function parseChainId(value: unknown): number | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? value : null;
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value)) return null;
  const parsed = Number.parseInt(value, 16);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
export function toHexChainId(chainId: number): string {
  return `0x${chainId.toString(16)}`;
}
export const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
export function firstAddress(accounts: unknown): string | null {
  const first = Array.isArray(accounts) ? accounts[0] : undefined;
  return typeof first === 'string' && ADDRESS.test(first) ? first : null;
}
