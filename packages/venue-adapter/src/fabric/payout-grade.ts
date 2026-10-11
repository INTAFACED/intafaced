import { formatAmount, MoneyError, parseAmount, type Amount } from '@intafaced/ledger-client/money';
import { VenueUnavailableError, midFromSnapshot, type PriceLevel, type VenueBookSnapshot } from '@intafaced/venue-contracts';

/**
 * PAYOUT-GRADE BOOKS — the absolute floor the fabric refuses to serve below.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS LIVES IN THE ADAPTER, NOT ONLY IN svc-trade
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `services/svc-trade/src/futures/mark-from-depth.ts` already treats a best
 * level worth less than this floor as ABSENT before minting a mid. That is the
 * right rule for a mark. It is not enough for the fabric: a dust book that
 * leaves the adapter looking like a real two-sided quote is still a dust book
 * for every other consumer — MM mid seed, cross-check, anything that mids
 * `snapshotBook` without re-running the trade gate.
 *
 * D26-P1-T8 closes that hole at the boundary. An adapter that has read both
 * sides and finds either best level below the floor REFUSES (`no_depth`) rather
 * than handing over a book that can mint a mid. Empty and one-sided books still
 * pass through unchanged — "no liquidity" is a fact, not a dust quote pretending
 * to be one.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ONE NUMBER, NOT A SECOND RULING
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `DEFAULT_MIN_BEST_LEVEL_NOTIONAL` is the SAME decimal string as
 * `mark-from-depth.ts` (`'100'` quote units). It is DIRECTION §8 item 8's
 * absolute floor — a placeholder awaiting the owner, not a considered risk
 * limit. A second default here would be a second unruled number. When the
 * owner rules, both call sites move together; until then the fabric and the
 * mark path refuse the same dust.
 *
 * Position-relative size (`DEFAULT_MIN_BEST_LEVEL_BPS_OF_NOTIONAL`) stays in
 * svc-trade: adapters do not know which position a mid would authorise.
 */

/** Absolute floor in quote-asset units. Must stay equal to mark-from-depth's. */
export const DEFAULT_MIN_BEST_LEVEL_NOTIONAL = '100';

const SCALE = 10n ** 18n;

export interface PayoutGradePolicy {
  /**
   * Decimal string, quote-asset units. Omitting the policy applies
   * `DEFAULT_MIN_BEST_LEVEL_NOTIONAL`. A missing or unreadable floor is
   * refused — that default is not a stand-in for either case.
   */
  readonly minBestLevelNotional?: string | null;
}

/**
 * Quote notional of one level (`price × quantity`), both operands 1e18-scaled.
 * Returns `0n` for non-positive inputs rather than inventing a floor pass.
 */
export function levelNotional(price: Amount, quantity: Amount): Amount {
  if (price <= 0n || quantity <= 0n) return 0n;
  return (price * quantity) / SCALE;
}

export function minBestLevelNotional(policy?: PayoutGradePolicy): Amount {
  if (policy === undefined) return parseAmount(DEFAULT_MIN_BEST_LEVEL_NOTIONAL);
  const raw = policy.minBestLevelNotional;
  if (raw == null) throw new MoneyError('payout floor is missing');
  return parseAmount(raw);
}

/** True when a resting best level clears the absolute payout-grade floor. */
export function bestLevelMeetsPayoutFloor(level: PriceLevel | undefined, policy?: PayoutGradePolicy): boolean {
  if (!level) return false;
  const [price, quantity] = level;
  return levelNotional(price, quantity) >= minBestLevelNotional(policy);
}

/**
 * Is this snapshot payout-grade for a two-sided mid?
 *
 * Empty / one-sided → `false` (no mid exists). Both sides present but either
 * best level below the floor → `false`. Both sides present and thick enough →
 * `true`.
 */
export function isPayoutGradeBook(snapshot: VenueBookSnapshot, policy?: PayoutGradePolicy): boolean {
  if (midFromSnapshot(snapshot) === null) return false;
  return bestLevelMeetsPayoutFloor(snapshot.bids[0], policy) && bestLevelMeetsPayoutFloor(snapshot.asks[0], policy);
}

/**
 * Refuse a dust two-sided book at the adapter boundary.
 *
 * Returns the snapshot unchanged when:
 *   · either side is empty (honest absence — caller decides whether to price), or
 *   · both best levels clear the absolute floor.
 *
 * Throws `VenueUnavailableError` with reason `no_depth` when both sides have a
 * best level and either fails the floor — the dust-book case that once minted
 * payout-grade mids off femto-cent depth.
 */
export function assertPayoutGradeBook(snapshot: VenueBookSnapshot, policy?: PayoutGradePolicy): VenueBookSnapshot {
  const bid = snapshot.bids[0];
  const ask = snapshot.asks[0];
  // No two-sided quote to defend. Empty and one-sided stay facts, not errors.
  if (!bid || !ask) return snapshot;

  const floor = minBestLevelNotional(policy);
  const bidOk = bestLevelMeetsPayoutFloor(bid, policy);
  const askOk = bestLevelMeetsPayoutFloor(ask, policy);
  if (bidOk && askOk) return snapshot;

  const bidN = formatAmount(levelNotional(bid[0], bid[1]));
  const askN = formatAmount(levelNotional(ask[0], ask[1]));
  throw new VenueUnavailableError(
    snapshot.venueId,
    'no_depth',
    `${snapshot.venueId} ${snapshot.symbol}: book is not payout-grade — best bid notional ${bidN}, ` +
      `best ask notional ${askN}, floor ${formatAmount(floor)} quote. Refusing rather than serving a dust book ` +
      'that could mint a mid (D26-P1-T8 / DEFAULT_MIN_BEST_LEVEL_NOTIONAL).',
  );
}
