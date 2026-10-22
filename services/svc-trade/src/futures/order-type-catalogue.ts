/**
 * Futures order-type catalogue (D-orders-01).
 *
 * Served at `GET /api/v1/futures/order-types`. Every order type, time in force
 * and ticket flag is listed with `state: available | refused`, so a ticket can
 * show each one and the typed reason it is refused instead of hiding it.
 *
 * Derived, never hard-coded on the client: `market` and `reduceOnly` are
 * available only while the capability matrix claims the open door
 * (`openPosition`) as supported; resting types refuse with the code the
 * resting door itself throws (conditional-orders/resting.ts), because futures
 * are market-at-mark only until resting futures orders are decided (P-1).
 */
import { CCXT_CAPABILITY_MATRIX, type CcxtCapabilityRow } from '../ccxt-capability-matrix.js';
import { FUTURES_RESTING_UNSUPPORTED } from './conditional-orders/resting.js';

export const FUTURES_ORDER_TYPE_UNSUPPORTED = 'trade.order_type_unsupported';

export const FUTURES_ORDER_TYPES = ['market', 'limit', 'post_only', 'scaled', 'twap'] as const;
export const FUTURES_TIME_IN_FORCE = ['GTC', 'IOC', 'FOK', 'GTD'] as const;
export const FUTURES_TICKET_FLAGS = ['reduceOnly', 'postOnly'] as const;

export type FuturesOrderTypeId = (typeof FUTURES_ORDER_TYPES)[number];
export type FuturesTimeInForce = (typeof FUTURES_TIME_IN_FORCE)[number];
export type FuturesTicketFlag = (typeof FUTURES_TICKET_FLAGS)[number];

export type CatalogueEntry<Id extends string> =
  | { readonly id: Id; readonly state: 'available' }
  | { readonly id: Id; readonly state: 'refused'; readonly code: string; readonly reason: string };

export interface FuturesOrderTypeCatalogue {
  readonly market: string;
  readonly orderTypes: readonly CatalogueEntry<FuturesOrderTypeId>[];
  readonly timeInForce: readonly CatalogueEntry<FuturesTimeInForce>[];
  readonly flags: readonly CatalogueEntry<FuturesTicketFlag>[];
}

const RESTING_REASON =
  'resting futures orders are unsupported: futures open and close at the accepted mark only, and a resting match does not update a futures position';
const OPEN_DOOR_REASON = 'the futures open door is not claimed as supported in the capability matrix';

function refused<Id extends string>(id: Id, code: string, reason: string): CatalogueEntry<Id> {
  return { id, state: 'refused', code, reason };
}

function openDoorSupported(matrix: readonly CcxtCapabilityRow[]): boolean {
  const row = matrix.find((r) => r.name === 'openPosition');
  return row !== undefined && row.kind === 'supported';
}

/** Build the catalogue for one listed futures market from the capability matrix. */
export function buildFuturesOrderTypeCatalogue(
  marketSymbol: string,
  matrix: readonly CcxtCapabilityRow[] = CCXT_CAPABILITY_MATRIX,
): FuturesOrderTypeCatalogue {
  const open = openDoorSupported(matrix);
  const atMark = <Id extends string>(id: Id): CatalogueEntry<Id> =>
    open ? { id, state: 'available' } : refused(id, FUTURES_ORDER_TYPE_UNSUPPORTED, OPEN_DOOR_REASON);
  const resting = <Id extends string>(id: Id): CatalogueEntry<Id> => refused(id, FUTURES_RESTING_UNSUPPORTED, RESTING_REASON);
  return {
    market: marketSymbol,
    orderTypes: FUTURES_ORDER_TYPES.map((id) => (id === 'market' ? atMark(id) : resting(id))),
    timeInForce: FUTURES_TIME_IN_FORCE.map((id) => resting(id)),
    flags: FUTURES_TICKET_FLAGS.map((id) => (id === 'reduceOnly' ? atMark(id) : resting(id))),
  };
}
