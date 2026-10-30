import type { TokenPageData } from '@intafaced/contracts/protocol-tokens';

/** `balanceOf(owner)` calldata: the ERC-20 selector, then the address left-padded to one 32-byte word. */
export function balanceOfCall(owner: string): string {
  return `0x70a08231${owner.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`;
}

/** One uint256 word from an `eth_call` answer, or null when the wallet gave no readable answer. */
export function readUnits(answer: string | null): bigint | null {
  if (answer === null || !/^0x[0-9a-fA-F]{1,64}$/.test(answer)) return null;
  return BigInt(answer);
}

/** The pool holding most of this token, so the ticket starts on the deepest market; null when it is in no pool. */
export function deepestPair(pairs: TokenPageData['pairs']): TokenPageData['pairs'][number] | null {
  return pairs.reduce<TokenPageData['pairs'][number] | null>(
    (best, pair) => (best === null || BigInt(pair.reserve) > BigInt(best.reserve) ? pair : best),
    null,
  );
}
