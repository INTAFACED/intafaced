import { TradeError } from './types.js';

/**
 * Create-body options the typed schema carries but spot does not act on yet are refused, never dropped: a caller who
 * sends a self-trade mode the engine lacks must be told it was not applied. A request whose own deadline has passed is
 * refused before any hold, whatever else is wrong with it.
 */
export interface PlacementOptions {
  readonly stpMode?: string;
  readonly tag?: string;
  readonly requestDeadline?: string;
  readonly triggerBy?: string;
  readonly timeInForce?: string;
  readonly expireAt?: string;
}

/** The engine's one self-trade mode: the resting order is cancelled and the incoming order continues. */
const ENGINE_STP_MODE = 'cancel_maker';

/**
 * `replay` is true when the caller's clientOrderId already names an order. A deadline means "do not create this after
 * T"; a replay creates nothing and returns the order that exists, so it is never refused as expired (the booked key
 * is always replayed).
 */
export function refuseUnsupportedPlacementOptions(options: PlacementOptions, now: Date, replay = false): void {
  if (!replay && hasSpentExpiry(options, now)) {
    throw new TradeError('the order expiry is not in the future; nothing was placed', 'trade.invalid_expiry');
  }
  if (!replay && options.requestDeadline !== undefined && Date.parse(options.requestDeadline) <= now.getTime()) {
    throw new TradeError('the request deadline has passed; nothing was placed', 'trade.request_expired');
  }
  if (options.stpMode !== undefined && options.stpMode !== ENGINE_STP_MODE) {
    throw new TradeError(
      `self-trade mode ${options.stpMode} is not supported; the engine cancels the resting order`,
      'trade.stp_mode_unsupported',
    );
  }
  refuseUnsetTriggerSource(options);
}

/** A GTD or GTT order whose own expiry is already past or exactly now could never rest. */
export function hasSpentExpiry(options: Pick<PlacementOptions, 'timeInForce' | 'expireAt'>, now: Date): boolean {
  return (
    (options.timeInForce === 'GTD' || options.timeInForce === 'GTT') &&
    options.expireAt !== undefined &&
    Date.parse(options.expireAt) <= now.getTime()
  );
}

/** A stop is released by the last trade only. The mark and index prices have no owner-published source yet. */
export function refuseUnsetTriggerSource(options: Pick<PlacementOptions, 'triggerBy'>): void {
  if (options.triggerBy !== undefined && options.triggerBy !== 'last') {
    throw new TradeError(
      `a stop is released by the last trade only; ${options.triggerBy} has no published source`,
      'trade.trigger_source_unset',
    );
  }
}

/**
 * A replacement cancels the original first, so an option that could be refused or ignored after that point is refused
 * before it: the replace door takes none of the three.
 */
export function refuseOptionsOnReplacement(options: PlacementOptions): void {
  if (options.requestDeadline !== undefined || options.stpMode !== undefined || options.tag !== undefined) {
    throw new TradeError('a replacement does not take a request deadline, a self-trade mode or a tag', 'trade.order_type_unsupported');
  }
  refuseUnsetTriggerSource(options);
}
