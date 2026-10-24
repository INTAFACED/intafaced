import { formatAmount, mulBps, parseAmount, type Amount } from '@intafaced/ledger-client';
import { TradeError, type Market, type OrderSide } from './types.js';

/**
 * Stop-market on spot (J-cex-spot-08 #3): a stop that trades at the market once a trade prints at its stop price.
 *
 * A market order carries no price to hold its funds at or to bound its fill, so a stop-market is placed as the
 * stop-limit it becomes: its limit is the owner's protection price measured from the stop, the same
 * `TRADE_MARKET_SLIPPAGE_CAP_BPS` a market order is bounded by. A buy pays at most the cap above its stop, a sell takes
 * at least the cap below it, and any part the book cannot fill inside that bound waits at it. The hold, the trigger, the
 * release and the cancel are the stop-limit's own; the stored kind (`stop`) turns the wire order back into the
 * stop-market the caller placed. A blank cap refuses `trade.protection_unset`: trade never invents a bound.
 */
export type StopKind = 'stop_limit' | 'stop';

export const STOP_MARKET = 'stop' as const;

function requireCap(capBps: number | null | undefined): number {
  if (capBps == null || !Number.isInteger(capBps) || capBps < 1 || capBps > 5000) {
    throw new TradeError(
      'a stop-market needs the owner protection cap (TRADE_MARKET_SLIPPAGE_CAP_BPS); it is unset, so the stop is refused rather than left unbounded',
      'trade.protection_unset',
    );
  }
  return capBps;
}

/**
 * The limit a stop-market is placed and held at: a buy's stop plus the cap, rounded down onto the tick; a sell's stop
 * minus the cap, rounded up onto the tick. Both stay inside the cap, and both stay on the stop's side of the book.
 */
export function stopMarketLimit(
  market: Pick<Market, 'symbol' | 'tickSize'>,
  side: OrderSide,
  stop: Amount,
  capBps: number | null | undefined,
): Amount {
  const cap = requireCap(capBps);
  if (stop <= 0n || market.tickSize <= 0n) {
    throw new TradeError('a stop-market requires a positive stopPrice', 'trade.missing_stop_price');
  }
  const slip = mulBps(stop, cap, 'floor');
  if (side === 'buy') {
    const capped = stop + slip;
    return capped - (capped % market.tickSize);
  }
  const floored = stop - slip;
  const remainder = floored % market.tickSize;
  const limit = remainder === 0n ? floored : floored + (market.tickSize - remainder);
  if (limit <= 0n) {
    throw new TradeError(`${market.symbol} stop-market floor would be non-positive; place a stop-limit instead`, 'trade.protection_unset');
  }
  return limit;
}

function parsedStop(raw: unknown): Amount | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  try {
    const value = parseAmount(raw.trim());
    return value > 0n ? value : null;
  } catch {
    return null;
  }
}

/**
 * The create (or replace) body a stop-market is placed with: `type: stop` becomes `type: stop_limit` at its protection
 * limit, good till cancelled. A body that is not a stop-market comes back untouched. A stop-market that names its own
 * price or an immediate time in force is refused: the price is the protection bound, and a stop rests until it fires.
 * A missing or malformed stopPrice leaves the body as sent, for the order schema to refuse as `a stop order requires a
 * stopPrice`.
 */
export function stopMarketBody(
  body: unknown,
  market: Pick<Market, 'symbol' | 'tickSize'> | null,
  capBps: number | null | undefined,
): { body: unknown; kind: StopKind | null } {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return { body, kind: null };
  const rec = body as Record<string, unknown>;
  if (rec.type !== STOP_MARKET) return { body, kind: null };
  if (rec.price !== undefined) {
    throw new TradeError('a stop-market is priced by the market: send no price, only the stopPrice', 'trade.invalid_price');
  }
  if (rec.timeInForce !== undefined && rec.timeInForce !== 'GTC') {
    throw new TradeError('a stop-market rests until it fires: use good-till-cancelled', 'trade.invalid_tif');
  }
  if (rec.postOnly === true) {
    throw new TradeError('a stop-market takes liquidity when it fires; it cannot be post-only', 'trade.invalid_tif');
  }
  const stop = parsedStop(rec.stopPrice);
  if (stop === null) return { body, kind: STOP_MARKET };
  if (!market) throw new TradeError(`market ${String(rec.symbol)} not found`, 'trade.market_not_found');
  const side: OrderSide = rec.side === 'buy' ? 'buy' : 'sell';
  const limit = stopMarketLimit(market, side, stop, capBps);
  return { body: { ...rec, type: 'stop_limit', price: formatAmount(limit), timeInForce: 'GTC' }, kind: STOP_MARKET };
}
