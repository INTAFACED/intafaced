/**
 * The liquidation price of an isolated position, read from the published maintenance ladder (D-margin-03).
 *
 * The ladder liquidates when equity falls below the maintenance requirement (`planLadderRung`: health under 10 000
 * bps). For a size S, entry E, margin M and maintenance fraction m, equity at a price P is `M + S·(P − E)` for a long
 * and `M + S·(E − P)` for a short, and the requirement is `m·S·P`. Setting the two equal:
 *
 *   long   P = (S·E − M) / (S·(1 − m))
 *   short  P = (S·E + M) / (S·(1 + m))
 *
 * The fraction m depends on the position's notional AT P against the book's depth, so each tier gives a candidate and
 * only a candidate that lands in its own tier describes the ladder. The book moves, so this is the price at today's
 * depth: it is shown, never stored. A stored liquidation price is an independent trigger in `liquidation-planner.ts`,
 * and an estimate must never become one.
 *
 * Rounded toward the mark (a long's up, a short's down). The ladder rounds its own requirement up and the loss away from
 * zero, so it acts at the price shown or within a rounding unit of it, never a cent past it.
 */
import { SCALE, type Amount } from '@intafaced/ledger-client';
import { assertLadderPolicyCoherent, maintenanceBpsFor, type FuturesLadderPolicy } from './maintenance-ladder.js';

const BPS = 10_000n;

export interface LiquidationPriceInput {
  readonly side: 'long' | 'short';
  readonly size: Amount;
  readonly entryPrice: Amount;
  /** The margin on the position now (after funding and adjustments). */
  readonly margin: Amount;
  /** Quote depth on the side the position closes into: the ladder's own input. */
  readonly depthNotional: Amount;
  readonly policy: FuturesLadderPolicy;
}

export type LiquidationPriceResult =
  | { readonly price: Amount; readonly maintenanceBps: number }
  /**
   * `no_price_above_zero`: a long whose margin covers its whole notional is never liquidated by price.
   * `between_tiers`: no tier's price lands in its own tier, so the ladder acts where the requirement steps from one
   * tier to the next. No single figure is shown for that rather than one the ladder does not use.
   */
  | { readonly price: null; readonly reason: 'empty_position' | 'no_price_above_zero' | 'between_tiers' };

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

/** The price at which a tier's maintenance meets equity, or null when there is none above zero. */
function priceForTier(input: LiquidationPriceInput, maintenanceBps: number): Amount | null {
  const m = BigInt(maintenanceBps);
  const entryNotional = input.size * input.entryPrice; // scale 10^36
  const margin = input.margin * SCALE; // scale 10^36
  if (input.side === 'long') {
    const numerator = entryNotional - margin;
    const denominator = input.size * (BPS - m);
    if (numerator <= 0n || denominator <= 0n) return null;
    return ceilDiv(numerator * BPS, denominator);
  }
  return ((entryNotional + margin) * BPS) / (input.size * (BPS + m));
}

export function liquidationPriceFor(input: LiquidationPriceInput): LiquidationPriceResult {
  assertLadderPolicyCoherent(input.policy);
  if (input.size <= 0n || input.entryPrice <= 0n) return { price: null, reason: 'empty_position' };

  const tiers = [...new Set(input.policy.tiers.map((tier) => tier.maintenanceBps))];
  const fits: { price: Amount; maintenanceBps: number }[] = [];
  let any = false;
  for (const maintenanceBps of tiers) {
    const price = priceForTier(input, maintenanceBps);
    if (price === null || price <= 0n) continue;
    any = true;
    // The notional rounds up, as the ladder rates it.
    const notional = ceilDiv(input.size * price, SCALE);
    if (maintenanceBpsFor(notional, input.depthNotional, input.policy) === maintenanceBps) fits.push({ price, maintenanceBps });
  }
  if (!any) return { price: null, reason: 'no_price_above_zero' };
  if (fits.length === 0) return { price: null, reason: 'between_tiers' };
  // More than one fit: the one the ladder reaches first as the price moves against it.
  const first = fits.reduce((best, next) =>
    input.side === 'long' ? (next.price > best.price ? next : best) : next.price < best.price ? next : best,
  );
  return first;
}
