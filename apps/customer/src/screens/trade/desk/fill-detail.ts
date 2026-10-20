import type { Trade } from '@intafaced/exchange-contract/schemas';

/** Which side of the book a fill was on. Unknown stays unknown: a fill the service did not classify is never guessed. */
export function fillRole(fill: Pick<Trade, 'takerOrMaker'>): 'maker' | 'taker' | null {
  return fill.takerOrMaker === 'maker' || fill.takerOrMaker === 'taker' ? fill.takerOrMaker : null;
}

/** The rate the fee was charged at, as the service stated it (a ratio such as "0.001"), or null when it did not. */
export function fillFeeRate(fill: Pick<Trade, 'fee'>): string | null {
  return fill.fee?.rate ?? null;
}
