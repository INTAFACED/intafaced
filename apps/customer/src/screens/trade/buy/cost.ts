/**
 * The all-in cost of a Buy or Sell, worked out with exact decimals (no floats). Everything the card and the review
 * dialog say about cost comes from here, so the two can never disagree. A part that cannot be known is null ("—").
 */
import { ceilPlaces, dec, mulDown, mulUp, str, toPlaces } from './trade-math';

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
 * The worst price the customer can get, times the amount, in whole cents.
 * Buy: the MOST they can pay, rounded UP. Sell: the LEAST they get, rounded DOWN. Null without a protection price.
 */
export function protectedTotal(side: 'buy' | 'sell', amount: string, protectionPrice: string | null): string | null {
  const size = dec(amount);
  const limit = dec(protectionPrice);
  if (size === null || limit === null || limit <= 0n) return null;
  return side === 'buy' ? str(ceilPlaces(mulUp(size, limit), 2)) : toPlaces(mulDown(size, limit), 2);
}

export interface CostInput {
  side: 'buy' | 'sell';
  /** The coin amount the order is for. */
  base: string;
  /** The price the order was sized from. */
  price: string | null;
  baseAsset: string;
  quoteAsset: string;
  /** The service's numbers; null while they are not known yet. */
  preview: { estimatedFee: string | null; feeAsset: string | null; protectionPrice: string | null } | null;
}

export interface CostRows {
  /** About what the coins are worth, in the paying money. */
  estimated: string | null;
  fee: { amount: string; asset: string | null } | null;
  /** What the customer ends up with, about: coins after the fee (buy) or money after the fee (sell). */
  get: { kind: 'coin'; amount: string; afterFee: boolean } | { kind: 'money'; amount: string } | null;
  /** The most they pay (buy) or the least they get (sell), in whole cents. */
  limit: string | null;
}

export function costRows(input: CostInput): CostRows {
  const { side, base, price, baseAsset, quoteAsset, preview } = input;
  const estimated = price === null ? null : aboutValue(base, price);
  const feeAmount = preview?.estimatedFee ?? null;
  const fee = feeAmount === null ? null : { amount: feeAmount, asset: preview?.feeAsset ?? null };
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
  return { estimated, fee, get, limit: preview ? protectedTotal(side, base, preview.protectionPrice) : null };
}
