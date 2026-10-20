import { MoneyError, mulBps, sub, type Amount } from '@intafaced/ledger-client';
import {
  discountedFeeBps,
  FeeScheduleError,
  publishedProductBps,
  requirePublishedFeeSchedule,
  type FeeProduct,
  type FeeSelector,
  type OwnerFeeSchedule,
} from './fee-schedule.js';

/**
 * FEE TIERS (§5.2 step 4, §4.1 rank perks).
 *
 * svc-identity publishes a machine-readable perk table and this service applies
 * the one entry it cares about — `feeDiscountBps` — without knowing what a rank
 * means. That indirection is why the ladder can be re-tuned without touching
 * this file.
 *
 * Pure. No I/O, no clock. The discount that was in force when an order was
 * accepted is snapshotted onto the order row, and this function is what turns
 * it into the rate the `tradeFill` recipe is handed.
 */

/**
 * Whether a side still receives a positive amount after its fee is taken.
 *
 * Mirrors `tradeFill` / `marketMakerMakerFill` in ledger-client: fees use
 * `mulBps` ceil, and a fee that equals the receivable emits a zero-amount
 * entry the ledger refuses. That refusal used to land AFTER `settleFill`
 * inserted fill rows, so the fills table stayed permanently ahead of the
 * ledger and re-runs could not heal (remainingHold overstated consumption).
 * Call this BEFORE any fill row write.
 *
 * @returns true when both sides keep a strictly positive receivable
 */
export function fillReceivablesSurviveFees(input: {
  /** What the taker pays (quote on buy, base on sell). */
  readonly takerPaysAmount: Amount;
  /** What the maker pays (base on buy, quote on sell). */
  readonly makerPaysAmount: Amount;
  readonly makerFeeBps: number;
  readonly takerFeeBps: number;
}): boolean {
  // Each side's fee is taken from what that side RECEIVES (the other side's pay).
  const takerFee = mulBps(input.makerPaysAmount, input.takerFeeBps);
  const makerFee = mulBps(input.takerPaysAmount, input.makerFeeBps);
  const takerReceives = sub(input.makerPaysAmount, takerFee);
  const makerReceives = sub(input.takerPaysAmount, makerFee);
  return takerReceives > 0n && makerReceives > 0n;
}

/**
 * Apply a rank discount to a published fee rate.
 *
 * ROUNDING. `feeDiscountBps` is a fraction OF THE FEE, not a subtraction from
 * it: 350 bps of discount on a 100 bps fee is 3.5 bps off, not 96.5% off. The
 * discount is floored, so the effective rate rounds UP — value credited to a
 * user is floored so rounding never invents value that has to come from
 * somewhere (`money.ts`).
 *
 * The honest consequence, stated rather than hidden: on a market with a small
 * published fee, a small discount rounds away entirely. A 25 bps discount on a
 * 10 bps maker fee is 0.025 bps, which is not representable, so the user pays
 * 10. That is a limitation of integer basis points, and integer basis points
 * are what the `tradeFill` recipe accepts.
 *
 * SOCKET §13 — amount-level fee discounting. Applying the discount to the fee
 * AMOUNT rather than to the RATE keeps all 18 decimal places, and is exactly
 * the change `feeCharge`'s token branch already makes for IFC-settled fees. It
 * needs `tradeFill` to accept fee amounts instead of bps, which is a
 * `packages/ledger-client` change and therefore its own PR first (§15.2).
 */
export function effectiveFeeBps(publishedBps: number, discountBps: number): number {
  if (!Number.isInteger(publishedBps) || publishedBps < 0 || publishedBps >= 10_000) {
    throw new MoneyError(`published fee must be 0..9999 bps, got ${publishedBps}`);
  }
  if (!Number.isInteger(discountBps) || discountBps < 0 || discountBps >= 10_000) {
    throw new MoneyError(`fee discount must be 0..9999 bps, got ${discountBps}`);
  }

  return discountedFeeBps(publishedBps, discountBps);
}

/** The two rates one match settles at. Each side carries its own snapshotted discount. */
export interface FillFeeRates {
  readonly makerFeeBps: number;
  readonly takerFeeBps: number;
}

/**
 * Resolve the pair of rates for one match from the owner schedule.
 *
 * Listing-row `maker_bps`/`taker_bps` are not a schedule. Unpublished throws
 * (`trade.fee_schedule_blank`) — never 10/20 invented here.
 *
 * Both sides are resolved together because `tradeFill` posts them in one
 * six-entry transaction — computing them apart would let a change to one side's
 * rounding drift away from the other's without anything failing.
 */
export function ratesForFill(
  schedule: OwnerFeeSchedule,
  makerDiscountBps: number,
  takerDiscountBps: number,
  product: FeeProduct = 'spot',
  selector?: FeeSelector,
): FillFeeRates {
  requirePublishedFeeSchedule(schedule);
  const rates = publishedProductBps(schedule, product, selector);
  if (!rates) {
    throw new FeeScheduleError(`${product} fee schedule is unpublished`, 'trade.fee_product_unpublished');
  }
  return {
    makerFeeBps: effectiveFeeBps(rates.makerBps, makerDiscountBps),
    takerFeeBps: effectiveFeeBps(rates.takerBps, takerDiscountBps),
  };
}

/**
 * Amounts each side pays on one match, matching `tradeFill`'s asset split.
 * Pure; used by the pre-insert fee guard so settleFill and the recipe agree.
 */
export function fillPayAmounts(input: { readonly takerSide: 'buy' | 'sell'; readonly qty: Amount; readonly quoteAmount: Amount }): {
  takerPaysAmount: Amount;
  makerPaysAmount: Amount;
} {
  const takerBuys = input.takerSide === 'buy';
  return {
    takerPaysAmount: takerBuys ? input.quoteAmount : input.qty,
    makerPaysAmount: takerBuys ? input.qty : input.quoteAmount,
  };
}
