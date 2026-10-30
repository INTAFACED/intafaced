/**
 * The numbers on the coin page, all from decimal strings in exact arithmetic (`data/decimal.ts`): nothing here turns a
 * price into a JS number. The chart itself draws from numbers in `CoinChart.tsx`; text never comes from those.
 */
import { classifyRefusal, partialWindowStart, dec, decOrNull, fractionDigits, ratio, roundScaled, sub, times, toFixedString } from './deps';
import type { Candle, Decimal, Loadable, TickerRow } from './deps';

export type Direction = 'up' | 'down' | 'flat';

export interface Move {
  /** What the range started at: the first candle's open. */
  base: Decimal;
  /** The price shown (live, or the candle under the crosshair). */
  price: Decimal;
  /** price - base, exact. */
  change: Decimal;
  /** change / base as a ratio string ("0.0275"), null when base is 0. */
  changeRatio: Decimal | null;
  direction: Direction;
}

/** The change of `price` since the range started. Null when either side is unknown. */
export function moveSince(candles: readonly Candle[], price: Decimal | null): Move | null {
  const base = candles[0]?.o;
  const from = dec(base);
  const to = dec(price);
  if (base === undefined || from === null || to === null) return null;
  const diff = sub(to, from);
  return {
    base,
    price: price as Decimal,
    change: decOrNull(diff) as Decimal,
    changeRatio: decOrNull(ratio(diff, from)),
    direction: diff > 0n ? 'up' : diff < 0n ? 'down' : 'flat',
  };
}

/**
 * The past day's change as the ticker already states it: from its 24 h open to its last price. It stands in for the
 * 1D line's change while the candles are still loading or could not be read, so "Past day" is never an empty dash when
 * the service has already said the figure. Null when the ticker has no open or no last price.
 */
export function tickerMove(ticker: TickerRow | null): Move | null {
  if (!ticker) return null;
  const from = dec(ticker.open24h);
  const to = dec(ticker.last);
  if (from === null || to === null || ticker.open24h === null || ticker.last === null) return null;
  const diff = sub(to, from);
  return {
    base: ticker.open24h,
    price: ticker.last,
    change: decOrNull(diff) as Decimal,
    changeRatio: decOrNull(ratio(diff, from)),
    direction: diff > 0n ? 'up' : diff < 0n ? 'down' : 'flat',
  };
}

/** A price rounded to the market's tick as the string HeroNumber animates, with its decimals. */
export function heroPrice(price: Decimal | null, tickSize: Decimal | null): { value: string | null; decimals: number } {
  const parsed = dec(price);
  const decimals = fractionDigits(tickSize) ?? 2;
  if (parsed === null) return { value: null, decimals };
  return { value: toFixedString(roundScaled(parsed, decimals), decimals), decimals };
}

export interface Extreme {
  /** Index into the candle list. */
  index: number;
  price: Decimal;
}

/**
 * The highest and lowest close on the line, for the two labels (UI-SPEC 5.5). The line is drawn from closes, so the
 * labels name closes. A line that never moves has no high and low to name.
 */
export function highLow(candles: readonly Candle[]): { high: Extreme; low: Extreme } | null {
  let high: { index: number; value: bigint } | null = null;
  let low: { index: number; value: bigint } | null = null;
  candles.forEach((candle, index) => {
    const value = dec(candle.c);
    if (value === null) return;
    if (!high || value > high.value) high = { index, value };
    if (!low || value < low.value) low = { index, value };
  });
  const top = high as { index: number; value: bigint } | null;
  const bottom = low as { index: number; value: bigint } | null;
  if (!top || !bottom || top.value === bottom.value) return null;
  return {
    high: { index: top.index, price: candles[top.index]!.c },
    low: { index: bottom.index, price: candles[bottom.index]!.c },
  };
}

/**
 * True when the market has less history than the range asks for, so the change is "since" its first trade and the
 * screen says so instead of calling it a week or a year.
 */
export function startsLate(candles: readonly Candle[], stepMs: number, spanMs: number, nowMs: number): boolean {
  const first = candles[0];
  if (!first) return false;
  const wanted = Math.floor(nowMs / stepMs) * stepMs - spanMs + stepMs;
  return first.t > wanted + stepMs;
}

/**
 * A listed market the exchange cannot price: its ticker is refused because no book is open for it (ETH and IFC on a
 * fresh exchange). That is "no market yet", not a fault, so there is nothing to retry and no support line to offer.
 */
export function isUnpricedMarket(ticker: Loadable<unknown>): boolean {
  if (ticker.status !== 'refused') return false;
  const kind = classifyRefusal(ticker.code);
  return kind === 'noBook' || kind === 'notFound';
}

/**
 * When the 1D line stands on the ticker's change (its candles are missing) and the ticker says the market is younger than
 * a day, the moment the figure starts from, so the line says "Since 14:00" instead of "Past day". Null otherwise.
 */
export function fallbackSince(candlesMissing: boolean, rangeId: string, ticker: TickerRow | null, nowMs: number): number | null {
  return candlesMissing && rangeId === '1D' && ticker ? partialWindowStart(ticker, nowMs) : null;
}

/**
 * Which quote the page prices in. A quote whose market has no open book is skipped while another one is priced, even if it
 * was chosen; with none priced, the chosen (else first) quote is kept so the "no market" card can name it.
 */
export function pickQuote(quotes: readonly string[], priced: readonly string[], chosen: string | null): string | null {
  const wanted = chosen !== null && quotes.includes(chosen) ? chosen : null;
  if (priced.length) return wanted !== null && priced.includes(wanted) ? wanted : priced[0]!;
  return wanted ?? quotes[0] ?? null;
}

/** One coin's open position as the lot book counts it (svc-tax `lotBook`), in exact decimals. */
export interface Position {
  quantity: Decimal;
  /** Dollars per coin the open lots cost, rounded half up to cents; null when any lot's cost is unknown. */
  averagePrice: Decimal | null;
  costBasis: Decimal | null;
  /** Value at the live price less the cost basis; null when either is unknown. */
  result: Decimal | null;
}

/** Dollars to the cent, half up (away from zero on a tie). */
const cents = (value: bigint): Decimal => toFixedString(roundScaled(value, 2, 'half-up'), 2);

/**
 * "Your position" (J-portfolio-10 #4): quantity, average price, cost basis and result from the lot book's open lots. The
 * result values the counted quantity at `priceUsd`, never the held amount, so lots left out of the figures (transfers,
 * while they are left out) do not move it.
 */
export function positionOf(row: { openQty: Decimal; openCostUsd: Decimal | null }, priceUsd: Decimal | null): Position | null {
  const quantity = dec(row.openQty);
  if (quantity === null || quantity <= 0n) return null;
  const cost = dec(row.openCostUsd);
  const price = dec(priceUsd);
  const average = cost === null ? null : ratio(cost, quantity);
  const result = cost === null || price === null ? null : sub(times(quantity, price), cost);
  return {
    quantity: row.openQty,
    averagePrice: average === null ? null : cents(average),
    costBasis: cost === null ? null : cents(cost),
    result: result === null ? null : cents(result),
  };
}
