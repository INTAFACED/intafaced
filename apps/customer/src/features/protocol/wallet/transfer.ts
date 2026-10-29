import { APP_CHAIN_ID } from './eip1193';

/**
 * Pure rules for the wallet room's Send, Receive and Scan sections. Nothing here reaches a network: the panels ask the
 * person's own wallet for anything that needs one (a contract check, a token check, the send itself).
 */

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** A name a name service would answer for (`alice.eth`, `shop.base.eth`): labels joined by dots, no spaces. */
const NAME = /^(?!0x)[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)+$/i;

export type Destination = { kind: 'empty' } | { kind: 'address'; address: string } | { kind: 'name'; name: string } | { kind: 'invalid' };

/** What the person typed in "To": an address, a name to resolve, or neither. */
export function readDestination(input: string): Destination {
  const text = input.trim();
  if (text === '') return { kind: 'empty' };
  if (ADDRESS.test(text)) return { kind: 'address', address: text };
  if (NAME.test(text)) return { kind: 'name', name: text.toLowerCase() };
  return { kind: 'invalid' };
}

export const sameAddress = (a: string | null | undefined, b: string | null | undefined) =>
  Boolean(a && b && a.toLowerCase() === b.toLowerCase());

/** The last four characters a person types to confirm a new address, compared without case. */
export const lastFour = (address: string) => address.slice(-4).toLowerCase();

/**
 * A decimal amount as whole base units (`1.5` with 18 decimals is 1500000000000000000n). Null when it is not a positive
 * decimal with at most `decimals` places. Never goes through a JavaScript number.
 */
export function toBaseUnits(amount: string, decimals: number): bigint | null {
  const text = amount.trim();
  const match = /^(\d{1,30})(?:\.(\d+))?$/.exec(text);
  if (!match) return null;
  const fraction = match[2] ?? '';
  if (fraction.length > decimals) return null;
  const units = BigInt(match[1]!) * 10n ** BigInt(decimals) + BigInt((fraction + '0'.repeat(decimals)).slice(0, decimals) || '0');
  return units > 0n ? units : null;
}

/** An answer to `decimals()` (one 32-byte word, at most 255): what a token contract gives and a plain wallet does not. */
export function isTokenDecimals(answer: string | null): boolean {
  if (!answer || !/^0x[0-9a-fA-F]{64}$/.test(answer)) return false;
  return BigInt(answer) <= 255n;
}

/** True when `code` (an eth_getCode answer) shows a contract at the address. */
export const isContractCode = (code: string) => code !== '0x' && code !== '0x0' && code.length > 2;

/** The selector of ERC-20 `decimals()`. */
export const DECIMALS_CALL = '0x313ce567';

export type ScanResult =
  | { kind: 'address'; address: string; chainId: number | null; token?: string }
  | { kind: 'connect'; uri: string }
  | { kind: 'otherNetwork'; chainId: number }
  | { kind: 'unknown' };

/**
 * What a scanned code holds. A payment address (`ethereum:0x…`, EIP-681, with an optional `@chain` and a `transfer`
 * call naming the recipient) or a bare address; a wallet connection request (`wc:…`); anything else is unknown. An
 * address for another network is named as such, never treated as this one.
 */
export function readScan(input: string, appChainId: number = APP_CHAIN_ID): ScanResult {
  const text = input.trim();
  if (ADDRESS.test(text)) return { kind: 'address', address: text, chainId: null };
  if (/^wc:[0-9a-f-]+@\d+\?/i.test(text)) return { kind: 'connect', uri: text };
  const pay = /^ethereum:(?:pay-)?(0x[0-9a-fA-F]{40})(?:@(\d{1,12}))?(?:\/([A-Za-z]\w*))?(?:\?(.*))?$/.exec(text);
  if (!pay) return { kind: 'unknown' };
  const chainId = pay[2] === undefined ? null : Number(pay[2]);
  if (chainId !== null && chainId !== appChainId) return { kind: 'otherNetwork', chainId };
  const fn = pay[3];
  if (fn === undefined) return { kind: 'address', address: pay[1]!, chainId };
  if (fn !== 'transfer') return { kind: 'unknown' };
  const recipient = new URLSearchParams(pay[4] ?? '').get('address');
  // A token request: the recipient, and the token it asks for (never sent as the network's own currency instead).
  return recipient && ADDRESS.test(recipient) ? { kind: 'address', address: recipient, chainId, token: pay[1]! } : { kind: 'unknown' };
}

/** The code the Receive section draws: an EIP-681 address on the app's network, so a scanning wallet picks the right one. */
export const receivePayload = (address: string, chainId: number = APP_CHAIN_ID) => `ethereum:${address}@${chainId}`;

/** The network's own currency, a fact of each chain (Base Sepolia's is test ETH). An unlisted network has none here. */
const NATIVE: Readonly<Record<number, { symbol: string; decimals: number }>> = {
  84532: { symbol: 'ETH', decimals: 18 },
  31337: { symbol: 'ETH', decimals: 18 },
};
export const nativeCurrency = (chainId: number = APP_CHAIN_ID) => (Object.hasOwn(NATIVE, chainId) ? NATIVE[chainId]! : null);

/** Hex for a transaction value. */
export const toHexValue = (units: bigint) => `0x${units.toString(16)}`;
