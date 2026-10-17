import type { Amount } from '@intafaced/ledger-client';

/**
 * Attached take-profit and stop-loss on one position (TRD-0339, TRD-0340, CRITPT-0013).
 *
 * stop-limit-place.ts stashes a single stop price for a stop-limit order. It does
 * not own the pair of exits on an entry. Cancelling an unfilled entry drops both.
 * A filled entry leaves them. A price the market has not traded through does not fill.
 */

export type AttachedExit = {
  readonly id: string;
  readonly kind: 'take_profit' | 'stop_loss';
  readonly trigger: Amount;
  readonly qty: Amount;
  readonly status: 'open' | 'cancelled' | 'filled';
};

export function cancelAttachedToEntry(input: {
  readonly entryStatus: 'unfilled' | 'partial' | 'filled';
  readonly filledQty: Amount;
  readonly exits: readonly AttachedExit[];
}): { readonly exits: readonly AttachedExit[]; readonly cancelledIds: readonly string[] } {
  if (input.entryStatus === 'filled') {
    return { exits: input.exits.map((leg) => ({ ...leg })), cancelledIds: [] };
  }
  if (input.entryStatus === 'partial') {
    return {
      exits: input.exits.map((leg) => (leg.status === 'open' ? { ...leg, qty: input.filledQty } : { ...leg })),
      cancelledIds: [],
    };
  }
  const cancelledIds = input.exits.filter((leg) => leg.status === 'open').map((leg) => leg.id);
  return {
    exits: input.exits.map((leg) => (leg.status === 'open' ? { ...leg, status: 'cancelled' as const } : { ...leg })),
    cancelledIds,
  };
}

/**
 * A stop the market has not traded through stays open and the position size
 * stays put. A print through the trigger may fill at the print, which can be
 * worse than the trigger. The trigger itself is not booked as the fill.
 */
export function stopAfterMarket(input: {
  readonly trigger: Amount;
  readonly last: Amount;
  readonly printedAtOrThroughTrigger: boolean;
  readonly printPrice: Amount | null;
  readonly positionSize: Amount;
  readonly status: AttachedExit['status'];
}): { readonly status: 'open' | 'triggered'; readonly positionSize: Amount; readonly fillPrice: Amount | null } {
  if (input.status !== 'open' || !input.printedAtOrThroughTrigger) {
    return { status: 'open', positionSize: input.positionSize, fillPrice: null };
  }
  return {
    status: 'triggered',
    positionSize: input.positionSize,
    fillPrice: input.printPrice,
  };
}
