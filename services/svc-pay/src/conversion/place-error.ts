import { VenueUnavailableError } from '@intafaced/venue-contracts';

/**
 * What a failed place attempt means for the order row.
 *
 * `pre_send` — the request never became a venue order (local governor, a
 * malformed call, a book that is not payout-grade, an unknown symbol). The
 * row goes back to `intent_committed` and a later retry may send it.
 * `rejected` — the venue answered that it refused the order. The row is
 * `failed` and the hold is released.
 * `ambiguous` — a timeout, a 5xx, or any other answer that does not prove the
 * order is absent. The row stays `placing`.
 */
export type PlaceFailureClass = 'pre_send' | 'rejected' | 'ambiguous';

/** Binance filter failure and new-order rejected. The order was not accepted. */
const BINANCE_REJECTED = new Set([-1013, -2010]);

/**
 * Bybit spot equivalents of a filter failure or an insufficient balance.
 * A duplicate client id is not in this set: that order may already exist.
 */
const BYBIT_REJECTED = new Set([170130, 170131, 170132, 170133, 170134, 170135, 170136, 170137, 170140]);

/** The venue named a symbol it does not list. Nothing was accepted. */
const BINANCE_UNKNOWN_SYMBOL = new Set([-1121]);
const BYBIT_UNKNOWN_SYMBOL = new Set([170121]);

export function classifyPlaceFailure(error: unknown): PlaceFailureClass {
  if (!(error instanceof VenueUnavailableError)) return 'ambiguous';
  if (
    error.reason === 'malformed' ||
    error.reason === 'not_ready' ||
    error.reason === 'rate_limited' ||
    error.reason === 'no_depth' ||
    /not payout-grade/i.test(error.message) ||
    /unknown symbol/i.test(error.message)
  ) {
    return 'pre_send';
  }
  const binance = /(?:^|\s)code (-?\d+)\b/.exec(error.message);
  if (binance) {
    const code = Number(binance[1]);
    if (BINANCE_REJECTED.has(code)) return 'rejected';
    if (BINANCE_UNKNOWN_SYMBOL.has(code)) return 'pre_send';
  }
  const bybit = /retCode (\d+)\b/.exec(error.message);
  if (bybit) {
    const code = Number(bybit[1]);
    if (BYBIT_REJECTED.has(code)) return 'rejected';
    if (BYBIT_UNKNOWN_SYMBOL.has(code)) return 'pre_send';
  }
  return 'ambiguous';
}
