/**
 * The spot order types the trading REST API accepts, in the order the spot ticket shows them (SP-order-entry-01;
 * J-cex-spot-15 #4). One list feeds three readers, so they cannot drift apart:
 *
 * - the ticket's type tabs and its "More order types" menu (`apps/customer/src/screens/trade/desk`);
 * - svc-trade's `GET /api/v1/order-types`, the list a bot reads;
 * - the developer portal's `/developers/order-types` page, drawn from that read.
 *
 * Each accepted type names how `POST /api/v1/orders` is sent for it (`send`: the body's `type` and the one flag or leg
 * field that makes it this kind) and the times in force it takes. A type the ticket lists but the service refuses
 * stays listed, with the code the service answers, so nothing is hidden and nothing is claimed.
 */
import { z } from 'zod';

export const SPOT_ORDER_TYPES_PATH = '/api/v1/order-types' as const;

export const SPOT_TICKET_ORDER_TYPES = ['limit', 'stop_limit', 'stop_market', 'oco', 'bracket', 'oto', 'market'] as const;
export type SpotTicketOrderType = (typeof SPOT_TICKET_ORDER_TYPES)[number];

export const SPOT_REFUSED_ORDER_TYPES = ['trailing_stop'] as const;
export type SpotRefusedOrderType = (typeof SPOT_REFUSED_ORDER_TYPES)[number];

export const SPOT_TIME_IN_FORCE = ['GTC', 'GTD', 'PO', 'IOC', 'FOK'] as const;
export type SpotTimeInForce = (typeof SPOT_TIME_IN_FORCE)[number];

/** The code the create door answers for a kind it does not take. */
export const SPOT_ORDER_TYPE_UNSUPPORTED = 'trade.order_type_unsupported' as const;

/** The body `type` a create carries, as `createOrderRequestSchema` names it. */
export type SpotBodyType = 'limit' | 'market' | 'stop' | 'stop_limit';

export interface SpotOrderTypeSend {
  /** The body's `type`. A bracket's entry is a limit with an entry price, or a market without one. */
  readonly type: readonly SpotBodyType[];
  /** The fields that make the order this kind, beside the plain order fields. */
  readonly fields: readonly string[];
}

const send = (type: readonly SpotBodyType[], fields: readonly string[] = []): SpotOrderTypeSend => ({ type, fields });

/**
 * How each ticket type reaches the create door, and the times in force the ticket offers for it. The create door
 * reads `takeProfit` and `stopLoss` as an OCO, `bracket: true` as a bracket, and `oto: true` with `close` as an OTO
 * (svc-trade `spot/oco-place.ts`, `spot/bracket-place.ts`).
 */
export const SPOT_ORDER_TYPE_SEND: Readonly<
  Record<SpotTicketOrderType, { send: SpotOrderTypeSend; timeInForce: readonly SpotTimeInForce[] }>
> = {
  limit: { send: send(['limit'], ['price']), timeInForce: ['GTC', 'GTD', 'PO', 'IOC', 'FOK'] },
  stop_limit: { send: send(['stop_limit'], ['price', 'stopPrice']), timeInForce: ['GTC'] },
  stop_market: { send: send(['stop'], ['stopPrice']), timeInForce: ['GTC'] },
  oco: { send: send(['limit'], ['takeProfit', 'stopLoss']), timeInForce: ['GTC'] },
  bracket: { send: send(['limit', 'market'], ['bracket', 'takeProfit', 'stopLoss']), timeInForce: ['IOC', 'FOK', 'GTC'] },
  oto: { send: send(['limit'], ['oto', 'close']), timeInForce: ['GTC', 'IOC', 'FOK'] },
  market: { send: send(['market']), timeInForce: ['GTC', 'FOK'] },
};

const sendSchema = z.object({
  type: z.array(z.enum(['limit', 'market', 'stop', 'stop_limit'])).min(1),
  fields: z.array(z.string()),
});

/** The `GET /api/v1/order-types` answer: every ticket type the API accepts, then every listed type it refuses. */
export const spotOrderTypesSchema = z.object({
  accepted: z.array(
    z.object({
      id: z.enum(SPOT_TICKET_ORDER_TYPES),
      send: sendSchema,
      timeInForce: z.array(z.enum(SPOT_TIME_IN_FORCE)).min(1),
    }),
  ),
  refused: z.array(z.object({ id: z.enum(SPOT_REFUSED_ORDER_TYPES), code: z.string().min(1) })),
});
export type SpotOrderTypes = z.infer<typeof spotOrderTypesSchema>;

/** The answer svc-trade serves, built from the lists above in the ticket's order. */
export function spotOrderTypes(): SpotOrderTypes {
  return {
    accepted: SPOT_TICKET_ORDER_TYPES.map((id) => ({
      id,
      send: { type: [...SPOT_ORDER_TYPE_SEND[id].send.type], fields: [...SPOT_ORDER_TYPE_SEND[id].send.fields] },
      timeInForce: [...SPOT_ORDER_TYPE_SEND[id].timeInForce],
    })),
    refused: SPOT_REFUSED_ORDER_TYPES.map((id) => ({ id, code: SPOT_ORDER_TYPE_UNSUPPORTED })),
  };
}
