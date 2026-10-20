import type { DeskRequest } from '@/lib/desk/approval-packet';

/** Pure parts of the listing form, so each rule is a test. The service still decides; this only keeps an unusable request off the wire. */

export const LISTING_MOVES = ['hide_pool', 'restore_pool', 'delist_market', 'restore_market'] as const;
export type ListingMove = (typeof LISTING_MOVES)[number];

export const MOVE_LABEL: Readonly<Record<ListingMove, string>> = {
  hide_pool: 'Hide a pool',
  restore_pool: 'Restore a pool',
  delist_market: 'Delist a market',
  restore_market: 'Relist a market',
};

export const moveNeedsReason = (move: ListingMove): boolean => move === 'hide_pool' || move === 'delist_market';
export const moveIsPool = (move: ListingMove): boolean => move === 'hide_pool' || move === 'restore_pool';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const REASON_CODE = /^[A-Za-z0-9._:-]{1,64}$/;

export interface ListingForm {
  readonly move: ListingMove;
  readonly chainId: string;
  readonly poolAddress: string;
  readonly symbol: string;
  readonly reasonCode: string;
}

/** The market symbol as the service keys it: trimmed and upper-case. */
export const cleanSymbol = (symbol: string): string => symbol.trim().toUpperCase();

/** Why the form cannot be sent yet, in words, or null. */
export function listingProblem(form: ListingForm): string | null {
  if (moveIsPool(form.move)) {
    if (!/^[1-9][0-9]{0,15}$/.test(form.chainId.trim())) return 'Enter the chain id as a whole number.';
    if (!ADDRESS.test(form.poolAddress.trim())) return 'Enter the pool address: 0x followed by 40 hexadecimal characters.';
  } else if (!/^[A-Z0-9][A-Z0-9._/-]{0,63}$/.test(cleanSymbol(form.symbol))) {
    return 'Enter the market symbol, for example IFC-USD.';
  }
  if (moveNeedsReason(form.move) && !REASON_CODE.test(form.reasonCode.trim())) {
    return 'Enter the reason code. svc-ops refuses any code the owner has not published.';
  }
  return null;
}

/** The request for a form that passed `listingProblem`. `reason` is the free text the approver reads and signs. */
export function listingRequest(form: ListingForm, reason: string): DeskRequest {
  const poolAddress = form.poolAddress.trim();
  const chainId = Number(form.chainId.trim());
  const symbol = cleanSymbol(form.symbol);
  const reasonCode = form.reasonCode.trim();
  switch (form.move) {
    case 'hide_pool':
      return { kind: 'protocol.pool.hide', chainId, poolAddress, reasonCode, reason };
    case 'restore_pool':
      return { kind: 'protocol.pool.restore', chainId, poolAddress };
    case 'delist_market':
      return { kind: 'protocol.market.delist', symbol, reasonCode, reason };
    case 'restore_market':
      return { kind: 'protocol.market.restore', symbol };
  }
}
