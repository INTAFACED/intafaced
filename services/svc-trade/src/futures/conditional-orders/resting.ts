/**
 * Resting futures limits.
 *
 * svc-matching lists an opaque market id when an operator opens a book. It has
 * no futures symbol and no product kind. PositionService does not take a fill
 * from that book: entryFromOpeningFills has no production caller, and a match
 * does not update trade.positions. This door refuses. It does not insert an
 * order and it does not build a matcher.
 */
import { FuturesError } from '../position-service.js';

export const FUTURES_RESTING_UNSUPPORTED = 'trade.futures_resting_unsupported';

export interface RestingLimitInput {
  readonly userId: string;
  readonly market: string;
  readonly side: 'buy' | 'sell';
  readonly quantity: string;
  readonly limitPrice: string;
  readonly reduceOnly: true;
  readonly clientOrderId: string;
}

export function refuseFuturesRestingLimit(_input: RestingLimitInput): Promise<never> {
  return Promise.reject(
    new FuturesError(
      'resting futures orders are unsupported: svc-matching has no futures symbol, and a match does not update a futures position',
      FUTURES_RESTING_UNSUPPORTED,
      501,
    ),
  );
}
