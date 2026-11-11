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
  /** The body's `type`. A bracket's entry is a market, or a limit with an entry price. */
  readonly type: readonly SpotBodyType[];
  /** The fields that make the order this kind, beside `symbol`, `side`, `amount` and `clientOrderId`. */
  readonly fields: readonly string[];
  /**
   * One whole body `POST /api/v1/orders` takes for this kind, with TEST figures: a leg is an object (`{ "stopPrice" }`,
   * a buy OCO's stop-loss also `price`; an OTO close `{ "price" }`), never a bare number. svc-trade's tests parse each one
   * with the create door's own schema and readers.
   */
  readonly example: Readonly<Record<string, unknown>>;
}

const base = (id: string) => ({ symbol: 'BTC/USDT', side: 'buy', amount: '0.001', clientOrderId: `TEST-example-${id}` });

/**
 * How each ticket type reaches the create door, and the times in force the ticket offers for it. The create door
 * reads `oco: true` with `takeProfit` and `stopLoss` legs as an OCO, `bracket: true` with both legs as a bracket, and
 * `oto: true` with a `close` as an OTO (svc-trade `spot/oco-place.ts`, `spot/bracket-place.ts`), the same bodies the
 * ticket sends (`apps/customer/src/features/trade/trade-api.ts` `placeBody`).
 */
export const SPOT_ORDER_TYPE_SEND: Readonly<
  Record<SpotTicketOrderType, { send: SpotOrderTypeSend; timeInForce: readonly SpotTimeInForce[] }>
> = {
  limit: {
    send: { type: ['limit'], fields: ['price'], example: { ...base('limit'), type: 'limit', price: '100', timeInForce: 'GTC' } },
    timeInForce: ['GTC', 'GTD', 'PO', 'IOC', 'FOK'],
  },
  stop_limit: {
    send: {
      type: ['stop_limit'],
      fields: ['price', 'stopPrice'],
      example: { ...base('stop_limit'), type: 'stop_limit', price: '101', stopPrice: '100', timeInForce: 'GTC' },
    },
    timeInForce: ['GTC'],
  },
  stop_market: {
    send: {
      type: ['stop'],
      fields: ['stopPrice'],
      example: { ...base('stop_market'), type: 'stop', stopPrice: '100', timeInForce: 'GTC' },
    },
    timeInForce: ['GTC'],
  },
  oco: {
    send: {
      type: ['limit'],
      fields: ['price', 'oco', 'takeProfit', 'stopLoss'],
      example: {
        ...base('oco'),
        type: 'limit',
        price: '120',
        timeInForce: 'GTC',
        oco: true,
        takeProfit: { stopPrice: '90' },
        stopLoss: { stopPrice: '110', price: '120' },
      },
    },
    timeInForce: ['GTC'],
  },
  bracket: {
    send: {
      type: ['market', 'limit'],
      fields: ['bracket', 'takeProfit', 'stopLoss'],
      example: {
        ...base('bracket'),
        type: 'market',
        timeInForce: 'GTC',
        bracket: true,
        takeProfit: { stopPrice: '110' },
        stopLoss: { stopPrice: '90' },
      },
    },
    timeInForce: ['IOC', 'FOK', 'GTC'],
  },
  oto: {
    send: {
      type: ['limit'],
      fields: ['price', 'oto', 'close'],
      example: { ...base('oto'), type: 'limit', price: '100', timeInForce: 'GTC', oto: true, close: { price: '110' } },
    },
    timeInForce: ['GTC', 'IOC', 'FOK'],
  },
  market: {
    send: { type: ['market'], fields: [], example: { ...base('market'), type: 'market', timeInForce: 'GTC' } },
    timeInForce: ['GTC', 'FOK'],
  },
};

const sendSchema = z.object({
  type: z.array(z.enum(['limit', 'market', 'stop', 'stop_limit'])).min(1),
  fields: z.array(z.string()),
  example: z.record(z.string(), z.unknown()),
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
      send: {
        type: [...SPOT_ORDER_TYPE_SEND[id].send.type],
        fields: [...SPOT_ORDER_TYPE_SEND[id].send.fields],
        example: { ...SPOT_ORDER_TYPE_SEND[id].send.example },
      },
      timeInForce: [...SPOT_ORDER_TYPE_SEND[id].timeInForce],
    })),
    refused: SPOT_REFUSED_ORDER_TYPES.map((id) => ({ id, code: SPOT_ORDER_TYPE_UNSUPPORTED })),
  };
}
