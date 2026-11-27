import { formatAmount, parseAmount } from '../../../shared/money';
import type { VenueMarket, VenuePosition } from '../../../features/trade/venue-api';
import { calculateVenueMargin } from './venue-calculator-logic';

// Desk A's ticket summary: what this order would be, before the venue's own review. Every figure comes from the
// calculator's exact formulas over the venue's published rules; a figure the desk cannot know yet is null, never guessed.

export interface TicketSummary {
  /** Size times the entry, in the quote asset. */
  readonly value: string;
  /** The account's leverage on this market, from its open position there; null until the venue reports one. */
  readonly leverage: string | null;
  readonly margin: string | null;
  /** Isolated margin only: a cross position's liquidation depends on the whole account. */
  readonly liquidation: string | null;
  /** The opening fee at the venue's taker rate plus our builder fee; null when the venue publishes no rate. */
  readonly fee: string | null;
}

export function ticketSummary(input: {
  market: Pick<VenueMarket, 'marginTiers' | 'maintenanceMarginRate' | 'maxLeverageBps' | 'takerFeeBps'>;
  side: 'buy' | 'sell';
  size: string;
  entry: string | null;
  position: Pick<VenuePosition, 'leverageBps' | 'marginMode'> | undefined;
  builderFeeBps: string | null;
}): TicketSummary | null {
  if (!input.entry) return null;
  const leverage = input.position ? String(input.position.leverageBps / 10_000) : null;
  const side = input.side === 'buy' ? 'long' : 'short';
  // Leverage 1 when unknown only to reach the notional; its margin and liquidation are then dropped, not shown.
  const calc = calculateVenueMargin(
    input.market,
    { side, size: input.size, entryPrice: input.entry, exitPrice: input.entry, leverage: leverage ?? '1' },
    input.builderFeeBps,
  );
  if (!calc) return null;
  // Exit at the entry: the calculator's two fees are the same opening fee twice.
  const fee = calc.estimatedFees === null ? null : formatAmount(parseAmount(calc.estimatedFees) / 2n);
  return {
    value: calc.notional,
    leverage,
    margin: leverage ? calc.initialMargin : null,
    // The formula is isolated margin's; a cross position's liquidation rests on the whole account, so it waits for review.
    liquidation: leverage && input.position?.marginMode === 'isolated' ? calc.liquidationPrice : null,
    fee,
  };
}
