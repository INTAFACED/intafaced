import { div, formatAmount, mul, mulBps, parseAmount, sub, type Amount } from '@intafaced/ledger-client';
import { TradeError, type OrderSide } from '../spot/types.js';

/**
 * CONVERT QUOTE MATH — book is the *source*, not the trade.
 *
 * Walks visible depth to observe a reference, then worsens the average by a
 * published house convert spread. Accept settles those exact decimal amounts
 * against house inventory (ledger-client), never a matching-engine order.
 */

export type DepthLevel = readonly [price: string, size: string];

export interface ConvertQuoteInput {
  side: OrderSide;
  /** Base quantity the user wants to convert (buy or sell). */
  qty: Amount;
  /** Top-of-book first. Buy walks asks; sell walks bids. */
  levels: readonly DepthLevel[];
  /**
   * Extra house edge on top of the book, in bps of the filled notional.
   * Applied against the user: buys pay more, sells receive less.
   * Unset / non-integer refuses — never invent 10.
   */
  convertSpreadBps: number | null | undefined;
  /** Market tick — used only to keep reported prices on-grid after the spread. */
  tickSize: Amount;
}

export interface ConvertQuoteResult {
  /** Base quantity that can be filled against the visible book. */
  filledQty: Amount;
  /** Quote asset notional at the book before house spread. */
  bookNotional: Amount;
  /** Quote asset the user pays (buy) or receives (sell) after house spread. */
  userNotional: Amount;
  /** Volume-weighted average price the user sees after spread. */
  avgPrice: Amount;
  fullyFilled: boolean;
}

/** Book-referenced observation that priced the quote. Never invented. */
export interface ConvertSource {
  readonly kind: 'book';
  readonly symbol: string;
  readonly asOf: string;
}

export interface FirmConvertQuote {
  readonly quoteId: string;
  readonly userId: string;
  readonly symbol: string;
  readonly marketId: string;
  readonly side: OrderSide;
  readonly baseAsset: string;
  readonly quoteAsset: string;
  readonly inAsset: string;
  readonly outAsset: string;
  readonly inAmount: Amount;
  readonly outAmount: Amount;
  readonly requestedQty: Amount;
  readonly filledQty: Amount;
  readonly bookNotional: Amount;
  readonly userNotional: Amount;
  readonly avgPrice: Amount;
  readonly convertSpreadBps: number;
  readonly fullyFilled: boolean;
  readonly source: ConvertSource;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface BoundConvertFill {
  readonly quote: FirmConvertQuote;
  readonly fillPrice: Amount;
  readonly fillNotional: Amount;
  readonly acceptedAt: string;
}

function parseLevel(level: DepthLevel): { price: Amount; size: Amount } {
  const price = parseAmount(level[0]);
  const size = parseAmount(level[1]);
  if (price <= 0n || size <= 0n) {
    throw new TradeError('depth level must have positive price and size', 'trade.convert_bad_depth');
  }
  return { price, size };
}

/**
 * Owner convert spread. Blank / unset / non-integer refuses — never invent 10.
 * Out of 0–5000 is `trade.convert_bad_spread` (published but illegal).
 */
export function requireConvertSpreadBps(convertSpreadBps: number | null | undefined): number {
  if (convertSpreadBps == null || !Number.isInteger(convertSpreadBps)) {
    throw new TradeError(
      'TRADE_CONVERT_SPREAD_BPS is unset or not an integer — refuse rather than invent a convert spread',
      'trade.convert_spread_unset',
    );
  }
  if (convertSpreadBps < 0 || convertSpreadBps > 5000) {
    throw new TradeError('convert spread bps out of range', 'trade.convert_bad_spread');
  }
  return convertSpreadBps;
}

/**
 * Owner convert quote TTL (ms). Blank / unset / non-integer / non-positive
 * refuses — never invent 15000. Owner may publish 15000 explicitly.
 */
export function requireConvertQuoteTtlMs(convertQuoteTtlMs: number | null | undefined): number {
  if (convertQuoteTtlMs == null || !Number.isInteger(convertQuoteTtlMs) || convertQuoteTtlMs < 1) {
    throw new TradeError(
      'TRADE_CONVERT_QUOTE_TTL_MS is unset or not a positive integer — refuse rather than invent 15000',
      'trade.convert_quote_ttl_unset',
    );
  }
  return convertQuoteTtlMs;
}

/**
 * Floor/ceil a price onto the tick grid after a spread adjustment.
 * Buys round UP (user never underfunded); sells round DOWN (user never over-credited).
 */
export function snapToTick(price: Amount, tickSize: Amount, side: OrderSide): Amount {
  if (tickSize <= 0n) return price;
  const rem = price % tickSize;
  if (rem === 0n) return price;
  if (side === 'buy') return price + (tickSize - rem);
  return price - rem;
}

/**
 * Walk `levels` for up to `qty` base units, apply the house spread, and say what
 * the user pays (buy) or receives (sell). Pure bigint maths. Unlike
 * `estimateConvert` this never refuses on an empty fill or a spread that eats the
 * fill — the caller decides — so the spend search can probe any size.
 */
function priceBook(
  side: OrderSide,
  qty: Amount,
  levels: readonly DepthLevel[],
  convertSpreadBps: number,
): { filledQty: Amount; remaining: Amount; bookNotional: Amount; userNotional: Amount } {
  let remaining = qty;
  let bookNotional = 0n;
  let filledQty = 0n;

  for (const level of levels) {
    if (remaining === 0n) break;
    const { price, size } = parseLevel(level);
    const take = size < remaining ? size : remaining;
    // Notional floors the way tradeFill does — never invent wei the book did not offer.
    bookNotional += mul(price, take, 'floor');
    filledQty += take;
    remaining -= take;
  }

  const spread = mulBps(bookNotional, convertSpreadBps, 'ceil');
  const userNotional = side === 'buy' ? bookNotional + spread : bookNotional > spread ? sub(bookNotional, spread) : 0n;
  return { filledQty, remaining, bookNotional, userNotional };
}

function finishEstimate(
  side: OrderSide,
  tickSize: Amount,
  walked: { filledQty: Amount; remaining: Amount; bookNotional: Amount; userNotional: Amount },
): ConvertQuoteResult {
  const { filledQty, bookNotional, userNotional } = walked;
  if (userNotional <= 0n) {
    throw new TradeError('convert spread consumes the entire fill', 'trade.convert_spread_too_high');
  }

  // VWAP after spread: both legs are SCALE-fixed; use money div (not raw bigint).
  const rawAvg = div(userNotional, filledQty, side === 'buy' ? 'ceil' : 'floor');
  const avgPrice = snapToTick(rawAvg, tickSize, side);

  return {
    filledQty,
    bookNotional,
    userNotional,
    avgPrice,
    fullyFilled: walked.remaining === 0n,
  };
}

/**
 * Walk the book for `qty` base units and apply the convert spread.
 */
export function estimateConvert(input: ConvertQuoteInput): ConvertQuoteResult {
  if (input.qty <= 0n) {
    throw new TradeError('convert quantity must be strictly positive', 'trade.convert_invalid_qty');
  }
  const convertSpreadBps = requireConvertSpreadBps(input.convertSpreadBps);
  if (input.levels.length === 0) {
    throw new TradeError('no liquidity to quote against', 'trade.convert_no_liquidity');
  }

  const walked = priceBook(input.side, input.qty, input.levels, convertSpreadBps);
  if (walked.filledQty === 0n) {
    throw new TradeError('no liquidity to quote against', 'trade.convert_no_liquidity');
  }
  return finishEstimate(input.side, input.tickSize, walked);
}

export interface ConvertSpendInput {
  /** Spend is a buy concept: "spend 100 USDT". Sell is refused. */
  side: OrderSide;
  /** Most the user will pay, in the quote asset, spread included. Strictly positive. */
  quoteQty: Amount;
  levels: readonly DepthLevel[];
  convertSpreadBps: number | null | undefined;
  tickSize: Amount;
  /** Base quantity grid. The result is a whole number of lots. */
  lotSize: Amount;
}

export interface ConvertSpendResult extends ConvertQuoteResult {
  /** Base quantity bought: the largest whole number of lots whose cost fits `quoteQty`. */
  qty: Amount;
}

/**
 * Largest base amount on the lot grid whose total cost (book notional plus the
 * house spread) is <= `quoteQty`. Taker fee is 0 on convert, so spread is the
 * only mark-up and it is inside `userNotional`.
 *
 * Cost is non-decreasing in quantity (the book is walked best price first and
 * the spread is a rounded-up share of the notional), so a binary search over
 * the lot count finds the exact boundary. Every probe is the same bigint
 * walk `estimateConvert` uses, so the answer agrees with what a quote of that
 * base quantity would charge: `estimateConvert(qty).userNotional <= quoteQty`
 * and one more lot would exceed it (or the book).
 *
 * Refuses: sell side, non-positive spend, spend below one lot
 * (`trade.below_min_notional`), and spend the visible book cannot absorb
 * (`trade.convert_insufficient_depth`, same as a base quantity the book cannot fill).
 */
export function estimateConvertForSpend(input: ConvertSpendInput): ConvertSpendResult {
  if (input.side !== 'buy') {
    throw new TradeError('quoteQty (a spend amount) is supported on buy only — sell by base amount', 'trade.convert_invalid_qty');
  }
  if (input.quoteQty <= 0n) {
    throw new TradeError('convert spend must be strictly positive', 'trade.convert_invalid_qty');
  }
  if (input.lotSize <= 0n) {
    throw new TradeError('market lot size must be strictly positive', 'trade.convert_invalid_qty');
  }
  const convertSpreadBps = requireConvertSpreadBps(input.convertSpreadBps);
  if (input.levels.length === 0) {
    throw new TradeError('no liquidity to quote against', 'trade.convert_no_liquidity');
  }

  let depth = 0n;
  for (const level of input.levels) depth += parseLevel(level).size;
  const depthLots = depth / input.lotSize;
  if (depthLots === 0n) {
    throw new TradeError('no liquidity to quote against', 'trade.convert_no_liquidity');
  }

  const costOf = (lots: bigint) => priceBook(input.side, lots * input.lotSize, input.levels, convertSpreadBps).userNotional;
  const wholeBook = costOf(depthLots);
  if (wholeBook < input.quoteQty) {
    throw new TradeError(
      `insufficient book depth to spend ${formatAmount(input.quoteQty)} — the whole visible book costs ${formatAmount(wholeBook)}`,
      'trade.convert_insufficient_depth',
    );
  }

  // Invariant: costOf(lo) <= quoteQty and (hi is past the answer: costOf(hi) > quoteQty,
  // or hi is the whole book at exactly quoteQty). costOf(0) is 0.
  let lo = wholeBook === input.quoteQty ? depthLots : 0n;
  let hi = depthLots;
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if (costOf(mid) <= input.quoteQty) lo = mid;
    else hi = mid;
  }
  if (lo === 0n) {
    throw new TradeError(
      `spend ${formatAmount(input.quoteQty)} does not buy one ${formatAmount(input.lotSize)} lot — below the minimum`,
      'trade.below_min_notional',
    );
  }

  const qty = lo * input.lotSize;
  const estimate = finishEstimate(input.side, input.tickSize, priceBook(input.side, qty, input.levels, convertSpreadBps));
  return { ...estimate, qty };
}

export function legsForConvert(side: OrderSide, baseAsset: string, quoteAsset: string, filledQty: Amount, userNotional: Amount) {
  if (side === 'buy') {
    return { inAsset: quoteAsset, outAsset: baseAsset, inAmount: userNotional, outAmount: filledQty };
  }
  return { inAsset: baseAsset, outAsset: quoteAsset, inAmount: filledQty, outAmount: userNotional };
}

export function assertFirmConvertQuote(q: FirmConvertQuote): void {
  if (!q.quoteId.trim()) {
    throw new TradeError('convert quote id is required — refuse rather than invent', 'trade.convert_quote_missing');
  }
  if (!q.expiresAt.trim()) {
    throw new TradeError('convert quote expiry is required — refuse rather than invent', 'trade.convert_expiry_missing');
  }
  if (!q.source?.kind || q.source.kind !== 'book' || !q.source.asOf.trim() || !q.source.symbol.trim()) {
    throw new TradeError('convert quote source is required — refuse rather than invent a mid', 'trade.convert_source_missing');
  }
  if (q.inAmount <= 0n || q.outAmount <= 0n || q.filledQty <= 0n || q.userNotional <= 0n) {
    throw new TradeError('convert quote amounts are required — refuse rather than invent', 'trade.convert_amounts_missing');
  }
}

export function buildFirmConvertQuote(input: {
  quoteId: string;
  userId: string;
  symbol: string;
  marketId: string;
  side: OrderSide;
  baseAsset: string;
  quoteAsset: string;
  requestedQty: Amount;
  estimate: ConvertQuoteResult;
  convertSpreadBps: number;
  source: ConvertSource;
  now: Date;
  quoteTtlMs: number | null | undefined;
}): FirmConvertQuote {
  const quoteTtlMs = requireConvertQuoteTtlMs(input.quoteTtlMs);
  const legs = legsForConvert(input.side, input.baseAsset, input.quoteAsset, input.estimate.filledQty, input.estimate.userNotional);
  const quote: FirmConvertQuote = {
    quoteId: input.quoteId,
    userId: input.userId,
    symbol: input.symbol,
    marketId: input.marketId,
    side: input.side,
    baseAsset: input.baseAsset,
    quoteAsset: input.quoteAsset,
    ...legs,
    requestedQty: input.requestedQty,
    filledQty: input.estimate.filledQty,
    bookNotional: input.estimate.bookNotional,
    userNotional: input.estimate.userNotional,
    avgPrice: input.estimate.avgPrice,
    convertSpreadBps: input.convertSpreadBps,
    fullyFilled: input.estimate.fullyFilled,
    source: input.source,
    createdAt: input.now.toISOString(),
    expiresAt: new Date(input.now.getTime() + quoteTtlMs).toISOString(),
  };
  assertFirmConvertQuote(quote);
  return quote;
}

/**
 * Accept an unexpired firm quote at the quoted in/out amounts.
 * Missing quote/expiry/amounts refuse. Never invent a mid or fee.
 */
export function acceptConvertQuote(input: {
  quote: FirmConvertQuote;
  now: Date;
  /** If supplied, must equal quote.avgPrice — else last-look refuse. */
  assertedPrice?: Amount | null;
}): BoundConvertFill {
  assertFirmConvertQuote(input.quote);
  const expiresAt = Date.parse(input.quote.expiresAt);
  if (!Number.isFinite(expiresAt)) {
    throw new TradeError('convert quote expiry is required — refuse rather than invent', 'trade.convert_expiry_missing');
  }
  if (input.now.getTime() > expiresAt) {
    throw new TradeError('convert quote expired — refuse rather than requote', 'trade.convert_quote_expired');
  }
  if (input.assertedPrice != null && input.assertedPrice !== input.quote.avgPrice) {
    throw new TradeError(
      `convert price ${formatAmount(input.quote.avgPrice)} is not the amount you accepted ${formatAmount(input.assertedPrice)}`,
      'trade.convert_price_moved',
    );
  }
  return {
    quote: input.quote,
    fillPrice: input.quote.avgPrice,
    fillNotional: input.quote.userNotional,
    acceptedAt: input.now.toISOString(),
  };
}

/** Present a quote for the wire (decimal strings only for money). */
export function presentConvertQuote(q: FirmConvertQuote) {
  assertFirmConvertQuote(q);
  return {
    quoteId: q.quoteId,
    symbol: q.symbol,
    side: q.side,
    requestedQty: formatAmount(q.requestedQty),
    filledQty: formatAmount(q.filledQty),
    bookNotional: formatAmount(q.bookNotional),
    userNotional: formatAmount(q.userNotional),
    avgPrice: formatAmount(q.avgPrice),
    fullyFilled: q.fullyFilled,
    convertSpreadBps: q.convertSpreadBps,
    expiresAt: q.expiresAt,
    source: { kind: q.source.kind, symbol: q.source.symbol, asOf: q.source.asOf },
    inAsset: q.inAsset,
    outAsset: q.outAsset,
    inAmount: formatAmount(q.inAmount),
    outAmount: formatAmount(q.outAmount),
  };
}

export function presentBoundConvertFill(
  bound: BoundConvertFill,
  extra: { fillId: string; takerOrderId: string; makerOrderId: string; settledAt: string },
) {
  const q = bound.quote;
  return {
    quoteId: q.quoteId,
    fillId: extra.fillId,
    takerOrderId: extra.takerOrderId,
    makerOrderId: extra.makerOrderId,
    symbol: q.symbol,
    side: q.side,
    inAsset: q.inAsset,
    outAsset: q.outAsset,
    inAmount: formatAmount(q.inAmount),
    outAmount: formatAmount(q.outAmount),
    fillPrice: formatAmount(bound.fillPrice),
    fillNotional: formatAmount(bound.fillNotional),
    convertSpreadBps: q.convertSpreadBps,
    source: { kind: q.source.kind, symbol: q.source.symbol, asOf: q.source.asOf },
    expiresAt: q.expiresAt,
    acceptedAt: bound.acceptedAt,
    settledAt: extra.settledAt,
  };
}

export type ConvertTradeWire = ReturnType<typeof presentBoundConvertFill>;
