import { parseAmount, type Amount } from '@intafaced/ledger-client';
import { ltvBps } from './risk.js';

/**
 * BK-loan-01, J-bank-09 #2 and #3: the arithmetic behind the loan application's calculator and its fee line.
 * Pure, so the quote and `open` can be held to the same rounding: debt valued up, collateral valued down.
 */

const ONE = parseAmount('1');
const BPS = 10_000n;

/** `quantity` at `price` in the quote asset: debt rounded up, collateral down. The one rounding `open` and the quote share. */
export function quoteValue(quantity: Amount, price: Amount, rounding: 'floor' | 'ceil'): Amount {
  const raw = quantity * price;
  if (rounding === 'floor') return raw / ONE;
  return (raw + ONE - 1n) / ONE;
}

/** Collateral `quantity` at `price` in the quote asset, rounded down: the value `open` gives a pledge. */
function collateralValue(quantity: Amount, price: Amount): Amount {
  return quoteValue(quantity, price, 'floor');
}

/**
 * The smallest pledge whose opening LTV is within `maxLtvBps` when the debt is worth `debtValue`: the same test `open`
 * runs (`ltvBps(debtValue, floor(collateral × price)) <= maxLtvBps`), searched exactly, so a pledge of this amount opens
 * and one unit less does not. LTV only falls as collateral rises, so the search is monotone.
 */
export function minimumCollateral(debtValue: Amount, collateralPrice: Amount, maxLtvBps: number): Amount {
  if (debtValue <= 0n || collateralPrice <= 0n || maxLtvBps <= 0) {
    throw new RangeError('minimumCollateral needs a positive debt value, price and LTV cap');
  }
  const fits = (c: Amount) => ltvBps(debtValue, collateralValue(c, collateralPrice)) <= maxLtvBps;
  // The closed-form estimate, then grown until it fits: a starting point, never the answer.
  let hi = (debtValue * BPS * ONE + BigInt(maxLtvBps) * collateralPrice - 1n) / (BigInt(maxLtvBps) * collateralPrice) + 1n;
  while (!fits(hi)) hi *= 2n;
  let lo = 1n;
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    if (fits(mid)) hi = mid;
    else lo = mid + 1n;
  }
  return lo;
}

/**
 * The collateral price, in the quote asset, at which a loan worth `debtValue` against `collateral` reaches
 * `liquidationLtvBps`. Rounded up, so the figure shown is never below the price that would start a liquidation.
 */
export function liquidationPrice(debtValue: Amount, collateral: Amount, liquidationLtvBps: number): Amount {
  const denominator = BigInt(liquidationLtvBps) * collateral;
  return (debtValue * BPS * ONE + denominator - 1n) / denominator;
}

/** The owner's origination fee (`BANK_LOAN_ORIGINATION_FEE_BPS`): whole basis points 0 to 10000, or not set. */
export type OriginationFee = { readonly status: 'not_set' } | { readonly status: 'published'; readonly bps: number };

/** Blank, unset or not a whole number in range is not set: nothing is assumed, and no fee line is drawn. */
export function originationFee(raw: string | null | undefined): OriginationFee {
  const text = raw?.trim() ?? '';
  if (!/^\d{1,5}$/.test(text)) return { status: 'not_set' };
  const bps = Number(text);
  return bps <= 10_000 ? { status: 'published', bps } : { status: 'not_set' };
}

/** The fee on `principal` at `bps`, rounded up in the debt asset. */
export function originationFeeOn(principal: Amount, bps: number): Amount {
  return (principal * BigInt(bps) + BPS - 1n) / BPS;
}
