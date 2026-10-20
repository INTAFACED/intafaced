import { TradeError } from './types.js';

/**
 * Create-body options the typed schema carries but spot does not act on yet are refused, never dropped: a caller who
 * sends a self-trade mode or a tag must be told it was not applied. A request whose own deadline has passed is
 * refused before any hold, whatever else is wrong with it.
 */
export interface PlacementOptions {
  readonly stpMode?: string;
  readonly tag?: string;
  readonly requestDeadline?: string;
}

/** The engine's one self-trade mode: the resting order is cancelled and the incoming order continues. */
const ENGINE_STP_MODE = 'cancel_maker';

export function refuseUnsupportedPlacementOptions(options: PlacementOptions, now: Date): void {
  if (options.requestDeadline !== undefined && Date.parse(options.requestDeadline) <= now.getTime()) {
    throw new TradeError('the request deadline has passed; nothing was placed', 'trade.request_expired');
  }
  if (options.stpMode !== undefined && options.stpMode !== ENGINE_STP_MODE) {
    throw new TradeError(
      `self-trade mode ${options.stpMode} is not supported; the engine cancels the resting order`,
      'trade.stp_mode_unsupported',
    );
  }
  if (options.tag !== undefined) {
    throw new TradeError('order tags are not stored yet; resend without a tag', 'trade.tag_unsupported');
  }
}
