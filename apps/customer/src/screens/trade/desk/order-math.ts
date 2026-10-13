/**
 * Order form arithmetic and the client-side refusals (UI-SPEC 5.7 money path).
 *
 * Everything is a decimal string in and out, bigint in between (`parseAmount` scales to 18 places).
 * No float conversion anywhere in this file. The server stays the authority: these checks only stop an order
 * the market's published rules would refuse anyway, so the person hears why before anything is sent.
 */
import { div, mul, SCALE } from '@intafaced/ledger-client/money';
import { baseQuantityForValue, exactValue, portionInLots } from '../../../features/trade/trade-api';
import { formatAmount, parseAmount } from '../../../shared/money';
import type { DeskMarket } from './market';

export type Side = 'buy' | 'sell';
export type OrderType = 'limit' | 'market';

/** Best bid and ask of the book, null when that side is empty. */
export interface Reference {
  bestBid: string | null;
  bestAsk: string | null;
}

/** What is wrong with the form, as data; the words live in copy. */
export type Problem =
  | { kind: 'amountEmpty' }
  | { kind: 'priceEmpty' }
  | { kind: 'amountLot'; lot: string }
  | { kind: 'amountMin'; min: string }
  | { kind: 'priceTick'; tick: string }
  | { kind: 'valueMin'; min: string }
  | { kind: 'noPrice' };

export type Checked = { ok: true; amount: string; price: string | null } | { ok: false; problem: Problem };

/** Parse a decimal string; null for empty or malformed text. Never throws. */
export function scaled(value: string | null | undefined): bigint | null {
  if (value === null || value === undefined || value.trim() === '') return null;
  try {
    return parseAmount(value.trim());
  } catch {
    return null;
  }
}

const positive = (value: string | null | undefined): bigint | null => {
  const parsed = scaled(value);
  return parsed !== null && parsed > 0n ? parsed : null;
};

/** The price a market order is judged against: you buy at the best ask and sell at the best bid. */
export function referencePrice(side: Side, ref: Reference | null): string | null {
  if (!ref) return null;
  return side === 'buy' ? ref.bestAsk : ref.bestBid;
}

/** Same side as the person: a buy rests at the best bid, a sell at the best ask (never crosses the book). */
export function bboPrice(side: Side, ref: Reference | null): string | null {
  if (!ref) return null;
  return side === 'buy' ? ref.bestBid : ref.bestAsk;
}

/** Order value in the quote asset, floored: exact for a limit order, an estimate for a market order. */
export function orderValue(
  input: { side: Side; type: OrderType; price: string; amount: string },
  ref: Reference | null,
): { value: string; estimated: boolean } | null {
  const amount = positive(input.amount);
  if (amount === null) return null;
  const price = positive(input.type === 'limit' ? input.price : referencePrice(input.side, ref));
  if (price === null) return null;
  return { value: exactValue(formatAmount(price), formatAmount(amount)), estimated: input.type === 'market' };
}

/**
 * The refusals the client can make before sending: empty fields, amounts and prices off the market's
 * steps, below the minimum amount, below the minimum order value. Returns the canonical amount and price
 * (no trailing zeros) when the order is fit to preview.
 */
export function checkOrder(
  input: { side: Side; type: OrderType; price: string; amount: string },
  market: Pick<DeskMarket, 'tickSize' | 'lotSize' | 'minAmount' | 'minCost'>,
  ref: Reference | null,
): Checked {
  const amount = positive(input.amount);
  if (amount === null) return { ok: false, problem: { kind: 'amountEmpty' } };
  const lot = positive(market.lotSize);
  if (lot !== null && amount % lot !== 0n) return { ok: false, problem: { kind: 'amountLot', lot: market.lotSize } };
  const minAmount = positive(market.minAmount);
  if (minAmount !== null && amount < minAmount) return { ok: false, problem: { kind: 'amountMin', min: market.minAmount! } };

  let price: bigint | null = null;
  if (input.type === 'limit') {
    price = positive(input.price);
    if (price === null) return { ok: false, problem: { kind: 'priceEmpty' } };
    const tick = positive(market.tickSize);
    if (tick !== null && price % tick !== 0n) return { ok: false, problem: { kind: 'priceTick', tick: market.tickSize } };
  }

  const judged = price ?? positive(referencePrice(input.side, ref));
  if (judged === null) return { ok: false, problem: { kind: 'noPrice' } };
  const minCost = positive(market.minCost);
  if (minCost !== null && mul(judged, amount, 'floor') < minCost) return { ok: false, problem: { kind: 'valueMin', min: market.minCost! } };

  return { ok: true, amount: formatAmount(amount), price: price === null ? null : formatAmount(price) };
}

/**
 * The most the person can order, rounded DOWN to the lot size so an order never exceeds what they hold.
 * A sell is the whole balance. A buy is the balance divided by the price plus the taker fee, so the fee is covered.
 * Null while the balance or the price is unknown.
 */
export function maxAmount(args: {
  side: Side;
  type: OrderType;
  price: string;
  available: string | null;
  market: Pick<DeskMarket, 'lotSize' | 'taker'>;
  ref: Reference | null;
}): string | null {
  const available = scaled(args.available);
  const lot = positive(args.market.lotSize);
  if (available === null || lot === null) return null;
  if (args.side === 'sell') return formatAmount((available / lot) * lot);
  const price = positive(args.type === 'limit' ? args.price : referencePrice('buy', args.ref));
  const rate = scaled(args.market.taker);
  if (price === null || rate === null) return null;
  const perUnit = mul(price, SCALE + rate, 'ceil');
  if (perUnit <= 0n) return null;
  const raw = div(available, perUnit, 'floor');
  return formatAmount((raw / lot) * lot);
}

/** 25, 50, 75 or 100 percent of `max`, rounded down to the lot. */
export function portionOf(max: string | null, percent: 25 | 50 | 75 | 100, lotSize: string): string | null {
  if (max === null) return null;
  const value = portionInLots(max, BigInt(percent), lotSize);
  return value === null || scaled(value) === 0n ? null : value;
}

/** Amount that a typed order value buys at a limit price, rounded down to the lot. Null when it cannot buy one lot. */
export function amountForValue(value: string, price: string, lotSize: string): string | null {
  try {
    return baseQuantityForValue(value, price, lotSize);
  } catch {
    return null;
  }
}

/** Move the decimal point of a decimal string right by `places` ("0.01" x10 = "0.1"): the order book's grouping sizes. */
export function scaleStep(step: string, places: number): string {
  const parsed = scaled(step);
  if (parsed === null) return step;
  return formatAmount(parsed * 10n ** BigInt(places));
}

/** Does `value` sit on a whole step? Used by the steppers' consumers and tests. */
export function onStep(value: string, step: string): boolean {
  const v = scaled(value);
  const s = positive(step);
  return v !== null && s !== null && v % s === 0n;
}

/** Cut an amount down to a whole number of lots (a book click must never fill an off-step amount). */
export function floorToLot(amount: string, lotSize: string): string | null {
  const value = positive(amount);
  const lot = positive(lotSize);
  if (value === null || lot === null) return null;
  const floored = (value / lot) * lot;
  return floored <= 0n ? null : formatAmount(floored);
}

/** Pad a decimal string with zeros up to `places` decimals ("65000.1" at 2 places is "65000.10"); never cuts digits. */
export function padDecimals(value: string, places: number): string {
  if (scaled(value) === null) return value;
  const [whole = '0', fraction = ''] = value.split('.');
  return fraction.length >= places ? value : `${whole}.${fraction.padEnd(places, '0')}`;
}
