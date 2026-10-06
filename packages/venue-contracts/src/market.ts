import type { Amount } from '@intafaced/ledger-client/money';

/**
 * THE UNIFIED INSTRUMENT — §27's "one typed contract … normalised across CEXs,
 * DEXs/chains, and FX/CFD rails".
 *
 * ── Why normalisation is the whole product ──────────────────────────────────
 *
 * Every venue describes the same instrument differently, and the differences
 * are not cosmetic: one publishes a tick size, another a number of decimal
 * places; one quotes a perpetual in the base asset, another in the quote; one
 * calls it `BTCUSDT`, another `BTC-USD-SWAP`, a third `tBTCUSD`. Routing across
 * venues means comparing prices for the same thing, and "the same thing" has to
 * be a decision somebody made in code rather than a coincidence of naming.
 *
 * ── Precision is a size, not a count ────────────────────────────────────────
 *
 * `pricePrecision` is a TICK — the smallest price increment, as an `Amount`.
 * Not "8 decimal places". Two reasons:
 *
 *   · A count cannot express a tick of `0.5` or `25`, and index and FX
 *     instruments use exactly those. A venue with a 25-point tick and a
 *     decimal-count model rounds every order to a price the venue rejects.
 *   · An `Amount` is already the type every price in this platform is in, so
 *     rounding an order to a tick is one `div`/`mul` in the same scale rather
 *     than a `toFixed` — which returns a string via a float.
 *
 * ── What is NOT here ────────────────────────────────────────────────────────
 *
 * There is no `info` field carrying the venue's raw payload. CCXT has one and
 * it is how venue-specific behaviour leaks into supposedly-unified callers: the
 * moment a caller reads `market.info.someVenueField`, the abstraction has been
 * defeated and nobody can tell by reading the caller. If the fabric needs a
 * field, the field gets normalised here and named.
 */
export type VenueInstrumentType =
  | 'spot'
  /** Perpetual swap — no expiry, funding instead. */
  | 'perpetual'
  /** Dated future. `expiry` is non-null. */
  | 'future'
  | 'option'
  /** Spot bought with borrowed collateral. Borrow rate applies. */
  | 'margin'
  /** FX pair on a bridge rail. */
  | 'fx'
  /** Contract-for-difference on a bridge rail. */
  | 'cfd';

export interface VenuePrecision {
  /**
   * Smallest price increment. An order priced off-tick is rejected by the
   * venue, so this is a routing input, not a display hint.
   */
  readonly price: Amount;
  /** Smallest quantity increment (lot size). */
  readonly amount: Amount;
}

export interface VenueLimits {
  /** Smallest order the venue accepts, in base units. */
  readonly minAmount: Amount;
  /** `null` where the venue publishes no ceiling. Not zero — zero is a real limit. */
  readonly maxAmount: Amount | null;
  /**
   * Smallest notional (price × amount) the venue accepts, in quote units.
   *
   * The limit that actually bites: a route that splits an order across five
   * venues can produce legs that each clear `minAmount` and none of which clear
   * `minCost`, and the venue rejects them one at a time after we have committed.
   */
  readonly minCost: Amount;
  /**
   * Maximum leverage, in basis points of 1x — `10_000` is 1x, `500_000` is 50x.
   *
   * An integer because leverage is a ratio and ratios in this platform are
   * integers. `12.5x` is `125_000`. `null` on an unleveraged instrument.
   */
  readonly maxLeverageBps: number | null;
}

/**
 * What the venue charges, in basis points.
 *
 * `number` rather than `Amount` deliberately: a bps rate is a small integer, not
 * a quantity of money, and `mulBps` in ledger-client already takes exactly this.
 * The money is the result of applying it, and that is an `Amount`.
 *
 * `maker` may be negative — a rebate. A schedule that clamps it at zero silently
 * mis-prices every venue that pays for liquidity, which is most of them.
 */
export interface VenueFeeSchedule {
  readonly makerBps: number;
  readonly takerBps: number;
  /** Which tier these rates came from, where the venue publishes tiers. */
  readonly tier?: string;
  /**
   * True when these are the venue's PUBLISHED defaults rather than the rates
   * this account actually pays.
   *
   * Account-specific rates need credentials. Until the Venue Vault issues them,
   * every schedule the fabric holds is a default, and a route costed on default
   * fees for an account with a discount is wrong in the user's favour — but a
   * route costed on defaults for an account that pays MORE is wrong against
   * them. Either way the caller has to know which it is holding.
   */
  readonly indicative: boolean;
}

export interface VenueMarket {
  readonly venueId: string;
  /**
   * The unified symbol — `BASE/QUOTE` for spot, `BASE/QUOTE:SETTLE` for a
   * derivative. Never the venue's own spelling.
   */
  readonly symbol: string;
  /** What this venue calls it. Used when talking TO the venue, and nowhere else. */
  readonly venueSymbol: string;
  readonly type: VenueInstrumentType;
  readonly base: string;
  readonly quote: string;
  /** Asset the contract settles in. `null` for spot. */
  readonly settle: string | null;
  /** False when the venue has delisted or halted it. Excluded from routing. */
  readonly active: boolean;
  /** Base units per contract. `null` where one unit is one unit (all spot). */
  readonly contractSize: Amount | null;
  /** Non-null only for `future` and `option`. */
  readonly expiry: Date | null;
  readonly precision: VenuePrecision;
  readonly limits: VenueLimits;
  readonly fees: VenueFeeSchedule;
  /**
   * When THIS PROCESS read the definition. Our clock, not theirs.
   *
   * A venue that has silently stopped updating still answers, still looks
   * healthy, and still returns a plausible timestamp of its own. The only thing
   * that catches that is our clock at the moment of the read, which is why no
   * adapter may synthesise this from venue-supplied data.
   */
  readonly observedAt: Date;
}

/**
 * `BASE/QUOTE` or `BASE/QUOTE:SETTLE`. The one place the format is decided.
 *
 * Exported so an adapter cannot quietly invent a different spelling — two
 * adapters that disagree on how to write a symbol produce two markets the
 * router will never compare, and the failure looks like missing liquidity
 * rather than a naming bug.
 */
export function unifiedSymbol(base: string, quote: string, settle?: string | null): string {
  const spot = `${base.toUpperCase()}/${quote.toUpperCase()}`;
  return settle ? `${spot}:${settle.toUpperCase()}` : spot;
}

/** Split a unified symbol back apart. Returns `null` if it is not one. */
export function parseUnifiedSymbol(symbol: string): { base: string; quote: string; settle: string | null } | null {
  const match = /^([A-Z0-9]+)\/([A-Z0-9]+)(?::([A-Z0-9]+))?$/.exec(symbol);
  if (!match) return null;
  return { base: match[1]!, quote: match[2]!, settle: match[3] ?? null };
}

/**
 * A tick that is not a positive increment. Returning the original price would
 * post an off-tick limit as if the venue had accepted it.
 */
export class NonPositiveTickError extends Error {
  constructor() {
    super('non-positive tick');
    this.name = 'NonPositiveTickError';
  }
}

/**
 * Round a limit toward a better or equal price: down for a buy, up for a sell.
 *
 * A buy that rounds up can fill up to one tick above the requested limit. A
 * sell that rounds down can fill up to one tick below it. Those are the worse
 * outcomes — a buy that crosses further than authorised, or a sell that fills
 * cheaper than the quote. Rounding toward a cheaper buy or a dearer sell means
 * execution can only be better than the quote; the order may sit unfilled
 * instead.
 */
export function roundToTick(price: Amount, tick: Amount, side: 'buy' | 'sell'): Amount {
  if (tick <= 0n) throw new NonPositiveTickError();
  const remainder = price % tick;
  if (remainder === 0n) return price;
  // `price` is always positive here (a negative price is refused at the wire).
  return side === 'buy' ? price - remainder : price - remainder + tick;
}

/** Round a quantity down to the venue's lot size. Never up — we cannot size beyond authority. */
export function roundToLot(amount: Amount, lot: Amount): Amount {
  if (lot <= 0n) return amount;
  return amount - (amount % lot);
}
