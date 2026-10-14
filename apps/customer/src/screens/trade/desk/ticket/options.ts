/**
 * Time in force and post-only (ticket v2). What the spot order API accepts today is checked against
 * `services/svc-trade` at origin/main: GTC, IOC and FOK, plus post-only (the service turns it into `PO`).
 * GTD and GTT are in the contract but the public path refuses them (no expiry time can be sent), so they are not offered.
 * Reduce-only is refused on spot.
 */
import type { OrderType } from '../order-math';

export type Tif = 'GTC' | 'IOC' | 'FOK';
export const TIF_VALUES: readonly Tif[] = ['GTC', 'IOC', 'FOK'];

export interface TicketOptions {
  timeInForce: Tif;
  postOnly: boolean;
}

export const DEFAULT_OPTIONS: TicketOptions = { timeInForce: 'GTC', postOnly: false };

/**
 * The options an order of this type may carry. A market order always keeps the old fixed values (it fills at once,
 * so neither choice means anything to it). Post-only is a promise to rest as a maker, so it only goes with GTC:
 * with IOC or FOK it is dropped here rather than sent for the service to refuse.
 */
export function effectiveOptions(type: OrderType, options: TicketOptions): TicketOptions {
  if (type === 'market') return DEFAULT_OPTIONS;
  return { timeInForce: options.timeInForce, postOnly: options.postOnly && options.timeInForce === 'GTC' };
}

/** Can the post-only switch be turned on with this time in force? */
export const postOnlyAllowed = (timeInForce: Tif): boolean => timeInForce === 'GTC';
