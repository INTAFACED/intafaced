/**
 * OMS external arb legs plan door — inventory-based execution only (D26-P1-X4).
 *
 * Plans buy+sell legs for a spotted opportunity. Refuses when either venue lacks
 * pre-positioned inventory — never sizes on bridge fantasy. Planning both legs
 * does not make their later cross-venue submission atomic.
 */
import { parseAmount } from '@intafaced/ledger-client';

export type OmsArbPlanLegsInput = {
  readonly symbol: string;
  readonly amount: string;
  readonly buyVenueId: string;
  readonly sellVenueId: string;
  readonly inventory: { readonly prePositionedByVenue: Readonly<Record<string, boolean>> };
};

export type OmsArbPlanLegRefuseReason = 'same_venue' | 'inventory_missing' | 'invalid_amount';

export type OmsArbLeg = {
  readonly side: 'buy' | 'sell';
  readonly venueId: string;
  readonly symbol: string;
  readonly amount: string;
};

export type OmsArbPlanLegsAccepted = {
  readonly ok: true;
  readonly atomic: false;
  readonly symbol: string;
  readonly amount: string;
  readonly legs: readonly [OmsArbLeg, OmsArbLeg];
};

export type OmsArbPlanLegsRefusal = {
  readonly ok: false;
  readonly reason: OmsArbPlanLegRefuseReason;
  readonly detail: string;
};

export type OmsArbPlanLegsResult = OmsArbPlanLegsAccepted | OmsArbPlanLegsRefusal;

/** Legacy symbol name retained for callers; the returned contract is explicitly non-atomic. */
export function planOmsArbAtomicLegs(input: OmsArbPlanLegsInput): OmsArbPlanLegsResult {
  let amount;
  try {
    amount = parseAmount(input.amount);
  } catch {
    return { ok: false, reason: 'invalid_amount', detail: 'amount is not a decimal string' };
  }
  if (amount <= 0n) {
    return { ok: false, reason: 'invalid_amount', detail: 'amount must be positive' };
  }

  if (input.buyVenueId === input.sellVenueId) {
    return { ok: false, reason: 'same_venue', detail: 'buy and sell venue must differ' };
  }

  const buyReady = input.inventory.prePositionedByVenue[input.buyVenueId] === true;
  const sellReady = input.inventory.prePositionedByVenue[input.sellVenueId] === true;
  if (!buyReady || !sellReady) {
    return {
      ok: false,
      reason: 'inventory_missing',
      detail: 'both venues must be pre-positioned for cross-venue arb legs — refuse bridge fantasy',
    };
  }

  return {
    ok: true,
    atomic: false,
    symbol: input.symbol,
    amount: input.amount,
    legs: [
      { side: 'buy', venueId: input.buyVenueId, symbol: input.symbol, amount: input.amount },
      { side: 'sell', venueId: input.sellVenueId, symbol: input.symbol, amount: input.amount },
    ],
  };
}
