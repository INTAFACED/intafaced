/**
 * P-trade-orders-11 / J-p2p-02 #4: automatic payment validation through a bank rail.
 *
 * The rail is a port. With none configured (every build today: no banking partner is wired) validation refuses with
 * the allowlisted `rail.bank` code and nothing moves. With one, the rail's confirmation of what arrived for an order is
 * compared exactly with the order: the same currency, the same amount and the order's own reference release once,
 * through the same decide-then-post as a seller's release; anything else leaves an exception row for a person and
 * releases nothing. Only methods the rail is set to validate (compliance's `railValidated` list) are checked at all.
 */
import type { Amount } from '@intafaced/ledger-client';

/** What the rail says arrived for one order. The adapter checks the rail's signature before it answers. */
export interface RailConfirmation {
  /** The rail's own id for this confirmation; an exception row is keyed by it. */
  readonly confirmationId: string;
  readonly currency: string;
  readonly amount: Amount;
  /** The payment reference the payer used. */
  readonly reference: string;
}

export interface PaymentRail {
  /** Payment methods compliance marked `railValidated` for this rail. */
  readonly methods: ReadonlySet<string>;
  /** The confirmation for this order, or null when nothing has arrived. A rail failure throws. */
  confirmation(order: { tradeId: string; sellerId: string; method: string; reference: string }): Promise<RailConfirmation | null>;
}

/** Why a confirmation does not release: each is left for a person. */
export type RailMismatch = 'currency' | 'amount' | 'reference';

/** Exact match only: no tolerance, no rounding, the order's own reference. */
export function railMismatch(
  order: { fiatCurrency: string; fiatAmount: Amount; reference: string },
  confirmation: RailConfirmation,
): RailMismatch | null {
  if (confirmation.currency !== order.fiatCurrency) return 'currency';
  if (confirmation.amount !== order.fiatAmount) return 'amount';
  if (confirmation.reference !== order.reference) return 'reference';
  return null;
}
