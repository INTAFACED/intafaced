import {
  FEE_RELAY_UNSET,
  FEE_TOKEN_NOT_ALLOWLISTED,
  FEE_TOKEN_ORACLE_STALE,
  FEE_TOKEN_ORACLE_UNREAD,
  type ProtocolFeeQuote,
  type ProtocolSwapToken,
} from '@intafaced/contracts/protocol-swap';

/**
 * Who pays a swap's network fee, and in what (RC-dex-protocol-02): the network's own currency from the person's wallet,
 * or a token they hold, priced by the fee relay from its oracle plus its published markup. A token the relay refuses
 * (off its allowlist, a stale or missing oracle mark, or no relay on this network) puts the choice back on native.
 */
export const NATIVE = 'native';

export type TokenFee =
  | { status: 'idle' }
  | { status: 'reading'; token: ProtocolSwapToken }
  | { status: 'ready'; token: ProtocolSwapToken; quote: ProtocolFeeQuote };

export type PayInRefusal = 'not_allowlisted' | 'oracle_stale' | 'oracle_unread' | 'relay_unset' | 'unread';

/** Why a token cannot pay the fee, from the service's refusal code; anything unnamed reads as "could not be read". */
export function payInRefusal(code: string | undefined): PayInRefusal {
  if (code === FEE_TOKEN_NOT_ALLOWLISTED) return 'not_allowlisted';
  if (code === FEE_TOKEN_ORACLE_STALE) return 'oracle_stale';
  if (code === FEE_TOKEN_ORACLE_UNREAD) return 'oracle_unread';
  if (code === FEE_RELAY_UNSET) return 'relay_unset';
  return 'unread';
}

/** The tokens offered to pay the fee: every token the pools trade and every token the relay lists, once each. */
export function payInTokens(pairTokens: readonly ProtocolSwapToken[], relayTokens: readonly ProtocolSwapToken[]): ProtocolSwapToken[] {
  const seen = new Set<string>();
  return [...pairTokens, ...relayTokens].filter((token) => {
    const key = token.address.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** keccak256("FeeCharged(address,address,address,uint256,uint256,uint16,uint256)"): the fee relay's charge event. */
export const FEE_CHARGED_TOPIC = '0x18d3fa3126c9b3ea120bc9a6df860b3edf1b12d4b2abdc8778eb9a7773084df0';

/**
 * What the fee relay actually charged `owner` in a mined swap, from its FeeCharged event (the last of its four data
 * words), or null when the receipt has none. The contract may take less than the signed most; this is what was taken.
 */
export function chargedIn(
  logs: ReadonlyArray<{ address: string; topics: readonly string[]; data: string }>,
  relay: string,
  owner: string,
): bigint | null {
  const who = `0x${owner.slice(2).toLowerCase().padStart(64, '0')}`;
  const event = logs.find(
    (log) =>
      log.address.toLowerCase() === relay.toLowerCase() &&
      log.topics[0]?.toLowerCase() === FEE_CHARGED_TOPIC &&
      log.topics[1]?.toLowerCase() === who &&
      log.data.length === 2 + 64 * 4,
  );
  return event ? BigInt(`0x${event.data.slice(2 + 64 * 3)}`) : null;
}
