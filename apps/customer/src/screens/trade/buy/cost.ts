/**
 * The all-in cost of a Buy or Sell, worked out with exact decimals (no floats). Everything the card and the review
 * dialog say about cost comes from here, so the two can never disagree. A part that cannot be known is null ("—").
 */
import { PAR_ASSETS } from '../../../data/derive';
import { ceilPlaces, dec, divDown, mulDown, mulUp, str, toPlaces } from './trade-math';

/** Coin amount times price, rounded down: what the order is worth at the price it was sized from. */
export function aboutValue(base: string, price: string): string | null {
  const amount = dec(base);
  const unit = dec(price);
  return amount === null || unit === null ? null : str(mulDown(amount, unit));
}

/** The coin amount less a fee taken in that same coin; null when the fee is in something else or unknown. */
export function afterFee(base: string, fee: string | null, feeAsset: string | null, coin: string): string | null {
  if (fee === null || feeAsset !== coin) return null;
  const amount = dec(base);
  const taken = dec(fee);
  return amount === null || taken === null || taken > amount ? null : str(amount - taken);
}

/** Money left after a fee taken in that same money (a sell paid in USDT); null when the fee is in another asset or unknown. */
export function afterQuoteFee(value: string | null, fee: string | null, feeAsset: string | null, quote: string): string | null {
  if (value === null || fee === null || feeAsset !== quote) return null;
  const amount = dec(value);
  const taken = dec(fee);
  return amount === null || taken === null || taken > amount ? null : str(amount - taken);
}

/**
 * What a fee is worth in dollars, so a fee in the coin and a fee in the paying money read the same way. A fee in a dollar
 * coin (USDT, USDC) is that many dollars; a fee in the coin is counted at `price`, the price of the order it was charged
 * on, when that price is in a dollar coin. Null when it cannot be counted in dollars.
 */
export function feeUsd(
  fee: string | null,
  feeAsset: string | null,
  baseAsset: string,
  quoteAsset: string,
  price: string | null,
): string | null {
  const taken = dec(fee);
  if (taken === null || feeAsset === null) return null;
  if (PAR_ASSETS.has(feeAsset.toUpperCase())) return str(taken);
  if (feeAsset !== baseAsset || !PAR_ASSETS.has(quoteAsset.toUpperCase())) return null;
  const unit = dec(price);
  return unit === null || unit <= 0n ? null : str(mulUp(taken, unit));
}

export interface Spread {
  bid: string;
  ask: string;
  /** Ask less bid, in the paying money. */
  width: string;
  /** The width as a share of the middle of bid and ask ("0.0029" is 0.29%). */
  ratio: string;
}

/** The best bid, the best ask and the gap between them; null unless both are known and the ask is not below the bid. */
export function spreadOf(bid: string | null, ask: string | null): Spread | null {
  const low = dec(bid);
  const high = dec(ask);
  if (low === null || high === null || low <= 0n || high < low) return null;
  const width = high - low;
  const share = divDown(width * 2n, low + high);
  return share === null ? null : { bid: str(low), ask: str(high), width: str(width), ratio: str(share) };
}

/**
 * The worst price the customer can get, times the amount, in whole cents.
 * Buy: the MOST they can pay, rounded UP. Sell: the LEAST they get, rounded DOWN. Null without a protection price.
 */
export function protectedTotal(
  side: 'buy' | 'sell',
  amount: string,
  protectionPrice: string | null,
  /** A fee charged in the paying money is part of the worst case; a fee in the coin is not. */
  fee?: { amount: string | null; asset: string | null; quote: string },
): string | null {
  const size = dec(amount);
  const limit = dec(protectionPrice);
  if (size === null || limit === null || limit <= 0n) return null;
  let charged = 0n;
  if (fee) {
    const taken = dec(fee.amount);
    // An unknown fee, or one in an unknown asset, leaves the worst case unknown.
    if (taken === null || (fee.asset === null && taken > 0n)) return null;
    if (fee.asset === fee.quote) charged = taken;
  }
  if (side === 'buy') return str(ceilPlaces(mulUp(size, limit) + charged, 2));
  const net = mulDown(size, limit) - charged;
  return toPlaces(net > 0n ? net : 0n, 2);
}

/**
 * The most a buyer can pay or the least a seller gets, with a fee charged in the paying money counted in. The card and
 * the review dialog both read this, so they always show the same worst case. Null when any part is unknown.
 */
export function limitFor(
  side: 'buy' | 'sell',
  amount: string,
  preview: { estimatedFee: string | null; feeAsset: string | null; protectionPrice: string | null },
  quoteAsset: string,
): string | null {
  return protectedTotal(side, amount, preview.protectionPrice, {
    amount: preview.estimatedFee,
    asset: preview.feeAsset,
    quote: quoteAsset,
  });
}

export interface CostInput {
  side: 'buy' | 'sell';
  /** The coin amount the order is for. */
  base: string;
  /** The price the order was sized from. */
  price: string | null;
  baseAsset: string;
  quoteAsset: string;
  /** The service's numbers; null while they are not known. */
  preview: { estimatedFee: string | null; feeAsset: string | null; protectionPrice: string | null } | null;
}

export interface CostRows {
  /** About what the coins are worth, in the paying money. */
  estimated: string | null;
  /** The fee in its own asset, and what it is worth in dollars (null when that cannot be counted). */
  fee: { amount: string; asset: string | null; usd: string | null } | null;
  /** What the customer ends up with, about: coins after the fee (buy) or money after the fee (sell). */
  get: { kind: 'coin'; amount: string; afterFee: boolean } | { kind: 'money'; amount: string } | null;
  /** The most they pay (buy) or the least they get (sell), in whole cents. */
  limit: string | null;
}

export function costRows(input: CostInput): CostRows {
  const { side, base, price, baseAsset, quoteAsset, preview } = input;
  const estimated = price === null ? null : aboutValue(base, price);
  const feeAmount = preview?.estimatedFee ?? null;
  const feeAsset = preview?.feeAsset ?? null;
  const fee =
    feeAmount === null ? null : { amount: feeAmount, asset: feeAsset, usd: feeUsd(feeAmount, feeAsset, baseAsset, quoteAsset, price) };
  let get: CostRows['get'] = null;
  if (preview) {
    if (side === 'buy') {
      const net = afterFee(base, feeAmount, preview.feeAsset, baseAsset);
      // Only claim the full amount when the fee is known to be taken from something else.
      if (net !== null) get = { kind: 'coin', amount: net, afterFee: true };
      else if (feeAmount !== null && preview.feeAsset !== null && preview.feeAsset !== baseAsset)
        get = { kind: 'coin', amount: base, afterFee: false };
    } else if (estimated !== null) {
      const net = afterQuoteFee(estimated, feeAmount, preview.feeAsset, quoteAsset);
      if (net !== null) get = { kind: 'money', amount: net };
      else if (feeAmount !== null && preview.feeAsset !== null && preview.feeAsset !== quoteAsset)
        get = { kind: 'money', amount: estimated };
    }
  }
  return {
    estimated,
    fee,
    get,
    limit: preview ? limitFor(side, base, preview, quoteAsset) : null,
  };
}
