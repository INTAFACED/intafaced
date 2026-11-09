/**
 * What the hand-run TESTNET tools (`live-conformance.ts`, `testnet-setup.ts`) need, and how they work it out
 * from the live testnet when the owner has not set it. Read-only: nothing here signs or sends.
 *
 * Every derived value is printed with where it came from. An explicit setting always wins and is used as given.
 */
import { add, compare, div, mul, parseAmount, sub, ZERO, type Amount } from '@intafaced/ledger-client/money';
import { decimalPlaces, priceProblem, type HlBook, type HyperliquidTestnetUserVenue } from '../src/index.js';

export const KEY_NAMES = ['trader', 'agent', 'other', 'third'] as const;
export type KeyName = (typeof KEY_NAMES)[number];

/** A 32-byte hex private key. The only shape a key file may hold. */
export function isHexKey(value: unknown): value is `0x${string}` {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
}

/**
 * The perpetual checks the runner runs. `null`: off, because the live venue always has a default leverage, so the
 * suite's "no leverage set refuses" step cannot be met (see `live-conformance.ts`). The setup script reads this too,
 * so it funds for the perp checks only when the runner runs them.
 */
export const LIVE_PERP: null = null;

/**
 * What the shared suite (`@intafaced/venue-sim`, conformance.ts) has `fund` give each role, as free balances.
 *   · trader: spot quote, up to 100000 (deposit:test:2, :5, :9, :10, :11);
 *   · other: 10 of the spot base (deposit:other:5, :9, :10); 100000 perp quote for the perp checks (deposit:other:perp);
 *   · third: 100000 perp quote, for the perp checks only (deposit:third:perp).
 * The live `fund` cannot credit: it checks the account already holds this.
 */
export const SUITE_FUNDS = {
  traderSpotQuote: parseAmount('100000'),
  otherSpotBase: parseAmount('10'),
  perpQuote: parseAmount('100000'),
} as const;

/**
 * The venue's smallest order value is 10 USDC ("Order must have minimum value of $10", Hyperliquid docs, "Tick and lot
 * size"). Derived sizes aim at 11, a small cushion over it.
 */
export const MIN_ORDER_VALUE = parseAmount('11');

/** The suite rests "away" bids at `price - 100` and sends market buys with a worst price of `price + 100`. */
const SUITE_PRICE_OFFSET = parseAmount('100');
/** A probe bid sits at 60 percent of the book: far from any fill, and inside the venue's band around its reference price. */
const PROBE_FRACTION = parseAmount('0.6');
const ONE_POINT_ZERO_ONE = parseAmount('1.01');
const ZERO_POINT_NINE_NINE = parseAmount('0.99');
const TWO = parseAmount('2');
/** How many spot pairs the runner reads books for when it picks one itself. */
const SPOT_CANDIDATES = 8;

const SCALE_DECIMALS = 18;

function step(dp: number): bigint {
  return 10n ** BigInt(SCALE_DECIMALS - dp);
}

/** `value` rounded down to `dp` decimal places. Positive values only. */
export function floorTo(value: Amount, dp: number): Amount {
  const s = step(dp);
  return (value / s) * s;
}

/** `value` rounded up to `dp` decimal places. Positive values only. */
export function ceilTo(value: Amount, dp: number): Amount {
  const s = step(dp);
  return ((value + s - 1n) / s) * s;
}

export type SettingSource = 'set' | 'derived';
export interface Resolved<T> {
  readonly value: T;
  readonly source: SettingSource;
}

export class SettingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettingError';
  }
}

type Env = Readonly<Record<string, string | undefined>>;

interface MarketShape {
  readonly symbol: string;
  readonly kind: 'spot' | 'perpetual';
  readonly szDecimals: number;
  readonly base: string;
  readonly quote: string;
}

async function marketShape(venue: HyperliquidTestnetUserVenue, symbol: string): Promise<MarketShape> {
  const m = (await venue.markets(null)).value.find((x) => x.symbol === symbol);
  if (!m) throw new SettingError(`${symbol} is not listed on the testnet`);
  return {
    symbol,
    kind: m.kind === 'spot' ? 'spot' : 'perpetual',
    szDecimals: decimalPlaces(m.lotSize),
    base: m.baseAsset,
    quote: m.quoteAsset,
  };
}

function maxPriceDecimals(m: MarketShape): number {
  return Math.max((m.kind === 'spot' ? 8 : 6) - m.szDecimals, 0);
}

/** The largest valid price at or below `target` that `accept` takes, trying finer decimals first. */
function validPriceAtOrBelow(target: Amount, m: MarketShape, accept: (p: Amount) => boolean): Amount | null {
  for (let dp = maxPriceDecimals(m); dp >= 0; dp -= 1) {
    const p = floorTo(target, dp);
    if (compare(p, ZERO) <= 0) continue;
    if (priceProblem(p, m.szDecimals, m.kind) === null && accept(p)) return p;
  }
  return null;
}

/**
 * A price strictly inside the book's spread, so the suite's own two orders at it meet each other and nobody else:
 * the maker's sell rests above the best bid, the taker's buy stays below the best ask. With one side empty, one
 * percent beyond the other side. `price - 100` and `price + 100` must be valid prices too (the suite uses both).
 */
export function spotPriceInside(book: HlBook, m: MarketShape): Amount | null {
  const bid = book.bids[0]?.price;
  const ask = book.asks[0]?.price;
  let target: Amount;
  if (bid !== undefined && ask !== undefined) target = div(add(bid, ask), TWO, 'floor');
  else if (bid !== undefined) target = mul(bid, ONE_POINT_ZERO_ONE, 'floor');
  else if (ask !== undefined) target = mul(ask, ZERO_POINT_NINE_NINE, 'floor');
  else return null;
  return validPriceAtOrBelow(target, m, (p) => {
    if (bid !== undefined && compare(p, bid) <= 0) return false;
    if (ask !== undefined && compare(p, ask) >= 0) return false;
    const away = sub(p, SUITE_PRICE_OFFSET);
    if (compare(away, ZERO) <= 0 || priceProblem(away, m.szDecimals, m.kind) !== null) return false;
    return priceProblem(add(p, SUITE_PRICE_OFFSET), m.szDecimals, m.kind) === null;
  });
}

/** A buy price far below the book (60 percent of the best bid, or of the best ask when there are no bids). */
export function probePriceFar(book: HlBook, m: MarketShape): Amount | null {
  const ref = book.bids[0]?.price ?? book.asks[0]?.price;
  if (ref === undefined) return null;
  return validPriceAtOrBelow(mul(ref, PROBE_FRACTION, 'floor'), m, () => true);
}

/** The smallest whole-lot size worth at least `MIN_ORDER_VALUE` at `price`. */
export function sizeForValue(price: Amount, szDecimals: number): Amount {
  return ceilTo(div(MIN_ORDER_VALUE, price, 'ceil'), szDecimals);
}

export interface SpotSettings {
  readonly symbol: Resolved<string>;
  readonly price: Resolved<Amount>;
  readonly size: Resolved<Amount>;
  readonly base: string;
  readonly quote: string;
}

export interface ProbeSettings {
  readonly symbol: Resolved<string>;
  readonly price: Resolved<Amount>;
  readonly size: Resolved<Amount>;
}

function explicit(env: Env, name: string): Amount | null {
  const v = env[name];
  if (v === undefined || v === '') return null;
  try {
    return parseAmount(v);
  } catch {
    throw new SettingError(`${name} is not a decimal number`);
  }
}

async function spotFor(venue: HyperliquidTestnetUserVenue, env: Env, symbol: Resolved<string>): Promise<SpotSettings> {
  const m = await marketShape(venue, symbol.value);
  if (m.kind !== 'spot') throw new SettingError(`${symbol.value} is not a spot market`);
  const setPrice = explicit(env, 'HL_SPOT_PRICE');
  let price: Resolved<Amount>;
  if (setPrice !== null) price = { value: setPrice, source: 'set' };
  else {
    const p = spotPriceInside((await venue.l2Book(m.symbol)).value, m);
    if (p === null) {
      throw new SettingError(
        `no price for ${m.symbol} fits strictly inside its book with price - 100 and price + 100 valid too (the suite uses both); set HL_SPOT_PRICE, or HL_SPOT_SYMBOL to a pair priced above 100`,
      );
    }
    price = { value: p, source: 'derived' };
  }
  const setSize = explicit(env, 'HL_SPOT_SIZE');
  let size: Resolved<Amount>;
  if (setSize !== null) size = { value: setSize, source: 'set' };
  else {
    const s = sizeForValue(price.value, m.szDecimals);
    // The suite gives `other` 10 of the base and has it sell `size` twice in one check.
    if (compare(add(s, s), SUITE_FUNDS.otherSpotBase) > 0) {
      throw new SettingError(
        `at ${m.symbol}'s price an order worth 11 USDC is more than half of the 10 ${m.base} the suite gives "other"; set HL_SPOT_SIZE, or pick a pair priced above 2.2`,
      );
    }
    size = { value: s, source: 'derived' };
  }
  return { symbol, price, size, base: m.base, quote: m.quote };
}

/**
 * The spot market, price and size the suite trades. `HL_SPOT_SYMBOL`, `HL_SPOT_PRICE` and `HL_SPOT_SIZE` win when
 * set. Unset, the symbol is the first USDC spot pair (by symbol) whose mid is above 100 and whose book leaves room
 * for a price inside the spread; the price is that inside price; the size is the smallest lot worth 11 USDC.
 */
export async function resolveSpot(venue: HyperliquidTestnetUserVenue, env: Env): Promise<SpotSettings> {
  const named = env.HL_SPOT_SYMBOL;
  if (named) return spotFor(venue, env, { value: named, source: 'set' });
  const markets = (await venue.markets(null)).value;
  const mids = (await venue.mids()).value;
  const candidates = markets
    .filter((m) => m.kind === 'spot' && m.quoteAsset === 'USDC' && !m.symbol.includes('@'))
    .filter((m) => {
      const mid = mids.get(m.symbol);
      return mid !== undefined && compare(mid, SUITE_PRICE_OFFSET) > 0;
    })
    .map((m) => m.symbol)
    .sort()
    .slice(0, SPOT_CANDIDATES);
  const tried: string[] = [];
  for (const symbol of candidates) {
    try {
      return await spotFor(venue, env, { value: symbol, source: 'derived' });
    } catch (error) {
      if (!(error instanceof SettingError)) throw error;
      tried.push(`${symbol}: ${error.message}`);
    }
  }
  throw new SettingError(
    `no USDC spot pair on the testnet suits the suite (mid above 100, room inside the spread)${tried.length ? `; tried ${tried.join('; ')}` : ''}; set HL_SPOT_SYMBOL`,
  );
}

/** The duplicate-cloid probe's market, price and size. `HL_PROBE_*` win when set; unset, ETH-PERP, 60 percent of the book, 11 USDC. */
export async function resolveProbe(venue: HyperliquidTestnetUserVenue, env: Env): Promise<ProbeSettings> {
  const symbol: Resolved<string> = env.HL_PROBE_SYMBOL
    ? { value: env.HL_PROBE_SYMBOL, source: 'set' }
    : { value: 'ETH-PERP', source: 'derived' };
  const m = await marketShape(venue, symbol.value);
  const setPrice = explicit(env, 'HL_PROBE_PRICE');
  let price: Resolved<Amount>;
  if (setPrice !== null) price = { value: setPrice, source: 'set' };
  else {
    const p = probePriceFar((await venue.l2Book(m.symbol)).value, m);
    if (p === null) throw new SettingError(`${m.symbol}'s book is empty: set HL_PROBE_PRICE`);
    price = { value: p, source: 'derived' };
  }
  const setSize = explicit(env, 'HL_PROBE_SIZE');
  const size: Resolved<Amount> =
    setSize !== null ? { value: setSize, source: 'set' } : { value: sizeForValue(price.value, m.szDecimals), source: 'derived' };
  return { symbol, price, size };
}
