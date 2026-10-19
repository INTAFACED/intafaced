/**
 * Order form arithmetic and the client-side refusals (UI-SPEC 5.7 money path).
 *
 * Everything is a decimal string in and out, bigint in between (`parseAmount` scales to 18 places).
 * No float conversion anywhere in this file. The server stays the authority: these checks only stop an order
 * the market's published rules would refuse anyway, so the person hears why before anything is sent.
 */
import { div, mul } from '@intafaced/ledger-client/money';
import { baseQuantityForValue, exactValue, portionInLots } from '../../../features/trade/trade-api';
import { formatAmount, parseAmount } from '../../../shared/money';
import type { DeskMarket } from './market';

export type Side = 'buy' | 'sell';
/**
 * `oco` (sell) and `bracket` (buy) are desk tabs, not service order types: the order the service takes is a limit
 * (OCO: priced at the take-profit) or a market/limit entry (bracket), with the exit prices riding beside it.
 */
export type OrderType = 'limit' | 'market' | 'stop_limit' | 'oco' | 'bracket';

/** The two tabs that attach a take-profit and a stop-loss. */
export const hasExits = (type: OrderType): boolean => type === 'oco' || type === 'bracket';

/** Limit, stop-limit and OCO carry a typed limit price; a market order is priced by the book and a bracket entry is when left empty. */
export const isPriced = (type: OrderType): boolean => type !== 'market' && type !== 'bracket';

/** True when the typed price is what the order is judged and held at (a bracket entry with no price is a market entry). */
export const usesTypedPrice = (type: OrderType, price: string): boolean =>
  isPriced(type) || (type === 'bracket' && positive(price) !== null);

/** The order type the service is asked for: a bracket with an entry price is a limit entry, without one a market entry. */
export const serviceType = (type: OrderType, price: string): 'market' | 'limit' | 'stop_limit' =>
  type === 'oco' ? 'limit' : type === 'bracket' ? (positive(price) === null ? 'market' : 'limit') : type;

/** An OCO works on either side; a bracket starts with a buy, so its sell side is off. */
export const exitSideOff = (side: Side, type: OrderType): boolean => type === 'bracket' && side === 'sell';

/** A buy OCO: the take-profit buys below the stop trigger, and the stop-loss is a limit order that sizes the one hold. */
export const isBuyOco = (side: Side, type: OrderType): boolean => type === 'oco' && side === 'buy';

/** Best bid and ask of the book, null when that side is empty. */
export interface Reference {
  bestBid: string | null;
  bestAsk: string | null;
}

/** What is wrong with the form, as data; the words live in copy. */
export type Problem =
  | { kind: 'amountEmpty' }
  | { kind: 'priceEmpty' }
  | { kind: 'stopEmpty' }
  | { kind: 'stopTick'; tick: string }
  | { kind: 'takeProfitEmpty' }
  | { kind: 'stopLossEmpty' }
  | { kind: 'takeProfitTick'; tick: string }
  | { kind: 'stopLossTick'; tick: string }
  | { kind: 'stopLimitEmpty' }
  | { kind: 'stopLimitTick'; tick: string }
  | { kind: 'stopLimitBelowTrigger' }
  | { kind: 'exitOrder' }
  | { kind: 'exitOrderBuy' }
  | { kind: 'entryBetween' }
  | { kind: 'amountLot'; lot: string }
  | { kind: 'amountMin'; min: string }
  | { kind: 'priceTick'; tick: string }
  | { kind: 'valueMin'; min: string }
  | { kind: 'noPrice' };

/** `stopLossLimit` is the buy OCO's stop-loss limit price (the stop-loss is the trigger); a sell OCO and a bracket have none. */
export type Exit = { takeProfit: string; stopLoss: string; stopLossLimit?: string };
export type Checked = { ok: true; amount: string; price: string | null; stopPrice?: string; exit?: Exit } | { ok: false; problem: Problem };

/** What the person typed. `price` is the limit price, the OCO take-profit, or the optional bracket entry price; `stopPrice` is the stop-limit trigger or the stop-loss. */
type FormInput = {
  side: Side;
  type: OrderType;
  price: string;
  amount: string;
  stopPrice?: string;
  stopLimit?: string;
  takeProfit?: string;
  tif?: string;
};

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
export function orderValue(input: FormInput, ref: Reference | null): { value: string; estimated: boolean } | null {
  const amount = positive(input.amount);
  if (amount === null) return null;
  // A buy OCO is held at its stop-loss limit, the worse of its two legs, so that is the value shown.
  if (isBuyOco(input.side, input.type)) {
    const limit = positive(input.stopLimit);
    return limit === null ? null : { value: exactValue(formatAmount(limit), formatAmount(amount)), estimated: false };
  }
  const typed = usesTypedPrice(input.type, input.price);
  const price = positive(typed ? input.price : referencePrice(input.side, ref));
  if (price === null) return null;
  return { value: exactValue(formatAmount(price), formatAmount(amount)), estimated: !typed };
}

/**
 * The refusals the client can make before sending: empty fields, amounts and prices off the market's
 * steps, below the minimum amount, below the minimum order value. Returns the canonical amount and price
 * (no trailing zeros) when the order is fit to preview.
 */
export function checkOrder(
  input: FormInput,
  market: Pick<DeskMarket, 'tickSize' | 'lotSize' | 'minAmount' | 'minCost'>,
  ref: Reference | null,
): Checked {
  const amount = positive(input.amount);
  if (amount === null) return { ok: false, problem: { kind: 'amountEmpty' } };
  const lot = positive(market.lotSize);
  if (lot !== null && amount % lot !== 0n) return { ok: false, problem: { kind: 'amountLot', lot: market.lotSize } };
  const minAmount = positive(market.minAmount);
  if (minAmount !== null && amount < minAmount) return { ok: false, problem: { kind: 'amountMin', min: market.minAmount! } };

  const tick = positive(market.tickSize);
  const offGrid = (value: bigint) => tick !== null && value % tick !== 0n;
  let price: bigint | null = null;
  if (isPriced(input.type)) {
    price = positive(input.price);
    if (price === null) return { ok: false, problem: { kind: input.type === 'oco' ? 'takeProfitEmpty' : 'priceEmpty' } };
    // An OCO's price field is its take-profit, which has its own wording.
    if (offGrid(price))
      return {
        ok: false,
        problem: input.type === 'oco' ? { kind: 'takeProfitTick', tick: market.tickSize } : { kind: 'priceTick', tick: market.tickSize },
      };
  } else if (input.type === 'bracket' && input.price.trim() !== '') {
    // The entry price of a bracket is optional: empty is a market entry.
    price = positive(input.price);
    if (price === null) return { ok: false, problem: { kind: 'priceEmpty' } };
    if (offGrid(price)) return { ok: false, problem: { kind: 'priceTick', tick: market.tickSize } };
  } else if (input.type === 'bracket' && input.tif === 'GTC') {
    // A resting entry is a limit order: with no entry price the form would send a market buy instead.
    return { ok: false, problem: { kind: 'priceEmpty' } };
  }

  let stop: bigint | null = null;
  if (input.type === 'stop_limit') {
    stop = positive(input.stopPrice);
    if (stop === null) return { ok: false, problem: { kind: 'stopEmpty' } };
    if (offGrid(stop)) return { ok: false, problem: { kind: 'stopTick', tick: market.tickSize } };
  }

  let exit: Exit | undefined;
  let heldAt: bigint | null = null;
  if (hasExits(input.type)) {
    const takeProfit = input.type === 'oco' ? price : positive(input.takeProfit);
    const stopLoss = positive(input.stopPrice);
    if (takeProfit === null) return { ok: false, problem: { kind: 'takeProfitEmpty' } };
    if (stopLoss === null) return { ok: false, problem: { kind: 'stopLossEmpty' } };
    if (offGrid(takeProfit)) return { ok: false, problem: { kind: 'takeProfitTick', tick: market.tickSize } };
    if (offGrid(stopLoss)) return { ok: false, problem: { kind: 'stopLossTick', tick: market.tickSize } };
    let stopLossLimit: bigint | null = null;
    if (isBuyOco(input.side, input.type)) {
      // The engine's order for a buy OCO: take-profit below the stop trigger, the stop-loss limit at or above it.
      stopLossLimit = positive(input.stopLimit);
      if (stopLossLimit === null) return { ok: false, problem: { kind: 'stopLimitEmpty' } };
      if (offGrid(stopLossLimit)) return { ok: false, problem: { kind: 'stopLimitTick', tick: market.tickSize } };
      if (takeProfit >= stopLoss) return { ok: false, problem: { kind: 'exitOrderBuy' } };
      if (stopLossLimit < stopLoss) return { ok: false, problem: { kind: 'stopLimitBelowTrigger' } };
      heldAt = stopLossLimit;
    } else if (takeProfit <= stopLoss) return { ok: false, problem: { kind: 'exitOrder' } };
    // A bracket that buys at a typed price exits above it and below it; anything else would sell at once.
    if (input.type === 'bracket' && price !== null && (price <= stopLoss || price >= takeProfit))
      return { ok: false, problem: { kind: 'entryBetween' } };
    exit = {
      takeProfit: formatAmount(takeProfit),
      stopLoss: formatAmount(stopLoss),
      ...(stopLossLimit === null ? {} : { stopLossLimit: formatAmount(stopLossLimit) }),
    };
  }

  const judged = heldAt ?? price ?? positive(referencePrice(input.side, ref));
  if (judged === null) return { ok: false, problem: { kind: 'noPrice' } };
  const minCost = positive(market.minCost);
  if (minCost !== null && mul(judged, amount, 'floor') < minCost) return { ok: false, problem: { kind: 'valueMin', min: market.minCost! } };

  return {
    ok: true,
    amount: formatAmount(amount),
    price: price === null ? null : formatAmount(price),
    ...(stop === null ? {} : { stopPrice: formatAmount(stop) }),
    ...(exit ? { exit } : {}),
  };
}

/**
 * The most the person can order, rounded DOWN to the lot size so an order never exceeds what they hold.
 * - A sell is the whole balance.
 * - A limit buy is the balance divided by the limit price: the service holds `price x amount`, and a buy's fee is
 *   taken from what is received, not from the balance.
 * - A market buy is the balance divided by the service's price protection (best ask plus the slippage cap), because
 *   that is the price the service holds against. Without a protection price the answer is null, never a guess.
 * Null while the balance or the price is unknown.
 */
export function maxAmount(args: {
  side: Side;
  type: OrderType;
  price: string;
  available: string | null;
  market: Pick<DeskMarket, 'lotSize'>;
  /** Price protection the service reported for a market buy (see `protectionNow`). */
  protectionPrice?: string | null;
  /** A buy OCO's stop-loss limit: its one hold is sized there. */
  stopLimit?: string;
}): string | null {
  const available = scaled(args.available);
  const lot = positive(args.market.lotSize);
  if (available === null || lot === null) return null;
  if (args.side === 'sell') return formatAmount((available / lot) * lot);
  const price = positive(
    isBuyOco(args.side, args.type) ? args.stopLimit : usesTypedPrice(args.type, args.price) ? args.price : (args.protectionPrice ?? null),
  );
  if (price === null) return null;
  const raw = div(available, price, 'floor');
  return formatAmount((raw / lot) * lot);
}

/**
 * The protection price moves with the best ask. A price protection seen when the ask was `seenAsk` is carried to the
 * current ask in proportion, rounded up so Max stays on the safe side. The exact hold is still checked from the
 * preview before anything can be reviewed (`holdShort`).
 */
export function protectionNow(protection: string | null, seenAsk: string | null, currentAsk: string | null): string | null {
  const p = positive(protection);
  const seen = positive(seenAsk);
  const now = positive(currentAsk);
  if (p === null || seen === null || now === null) return null;
  return formatAmount(div(mul(p, now, 'ceil'), seen, 'ceil'));
}

/** A small amount that clears the minimum order value at `ask`: used once to learn the market-buy price protection. */
export function probeAmount(market: Pick<DeskMarket, 'lotSize' | 'minAmount' | 'minCost'>, ask: string): string | null {
  const price = positive(ask);
  const lot = positive(market.lotSize);
  if (price === null || lot === null) return null;
  const minCost = positive(market.minCost) ?? 0n;
  let units = div(minCost, price, 'ceil');
  const minAmount = positive(market.minAmount) ?? 0n;
  if (units < minAmount) units = minAmount;
  units = ((units + lot - 1n) / lot) * lot;
  // A little over the minimum value, so the price moving a tick does not push the probe under it.
  units += lot * 2n;
  return units > 0n ? formatAmount(units) : null;
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
