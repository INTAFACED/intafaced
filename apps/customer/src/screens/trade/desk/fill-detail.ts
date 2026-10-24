import type { Trade } from '@intafaced/exchange-contract/schemas';

/** Which side of the book a fill was on. Unknown stays unknown: a fill the service did not classify is never guessed. */
export function fillRole(fill: Pick<Trade, 'takerOrMaker'>): 'maker' | 'taker' | null {
  return fill.takerOrMaker === 'maker' || fill.takerOrMaker === 'taker' ? fill.takerOrMaker : null;
}

/** The maker rebate the service paid on this fill, or null. A rebate is never read as a negative fee. */
export function fillRebate(fill: Pick<Trade, 'rebate'>): { cost: string; currency: string; rate: string } | null {
  return fill.rebate ?? null;
}

/**
 * A fee the service stated as exactly nothing: "Zero fee", not "0.00000000". A fill with a rebate also pays none. Takes a
 * fill, or an order's fills together.
 */
export function fillZeroFee(
  fill: Pick<Trade, 'fee'> | { readonly fee: { readonly cost: string; readonly currency: string } | null },
): boolean {
  return fill.fee !== null && /^0+(\.0+)?$/.test(fill.fee.cost);
}

/** The rate the fee was charged at, as the service stated it (a ratio such as "0.001"), or null when it did not. */
export function fillFeeRate(fill: Pick<Trade, 'fee'>): string | null {
  return fill.fee?.rate ?? null;
}
