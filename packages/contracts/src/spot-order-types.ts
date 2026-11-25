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

/**
 * The venue spot ticket's offered order types (J-cex-spot-15 #4, launch money model): the same two kinds
 * `VenueSpotDesk.tsx` draws as tabs when listed in the venue market's `orderTypes`.
 */
export const VENUE_SPOT_ORDER_TYPES = ['limit', 'market'] as const;
export type VenueSpotOrderType = (typeof VENUE_SPOT_ORDER_TYPES)[number];

/**
 * Order types the venue spot ticket lists beside limit and market (`VenueOrderOptions.tsx` `NotOfferedTypes`): any type
 * the venue market omits from `orderTypes` is shown disabled on the ticket and listed in `refused` here.
 */
export const VENUE_SPOT_OTHER_ORDER_TYPES = ['stop_limit', 'stop', 'take_profit', 'trailing_stop'] as const;
export type VenueSpotOtherOrderType = (typeof VENUE_SPOT_OTHER_ORDER_TYPES)[number];

export const VENUE_SPOT_TIME_IN_FORCE = ['GTC', 'IOC', 'FOK', 'ALO', 'GTD'] as const;
export type VenueSpotTimeInForce = (typeof VENUE_SPOT_TIME_IN_FORCE)[number];

/** The code the user-venue door answers for an order type the venue does not offer on that market. */
export const VENUE_SPOT_ORDER_TYPE_NOT_OFFERED = 'trade.venue.not_offered' as const;

export const SPOT_TIME_IN_FORCE = ['GTC', 'GTD', 'PO', 'IOC', 'FOK'] as const;
export type SpotTimeInForce = (typeof SPOT_TIME_IN_FORCE)[number];

const ALL_SPOT_TIME_IN_FORCE = ['GTC', 'GTD', 'PO', 'IOC', 'FOK', 'ALO'] as const;
export const ALL_SPOT_REFUSED_ORDER_TYPES = ['trailing_stop', 'stop_limit', 'stop', 'take_profit'] as const;
export type AnySpotRefusedOrderType = (typeof ALL_SPOT_REFUSED_ORDER_TYPES)[number];

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
  source: z.enum(['book', 'venue']).optional(),
  symbol: z.string().min(1).optional(),
  accepted: z.array(
    z.object({
      id: z.enum(SPOT_TICKET_ORDER_TYPES),
      send: sendSchema,
      timeInForce: z.array(z.enum(ALL_SPOT_TIME_IN_FORCE)).min(1),
    }),
  ),
  refused: z.array(z.object({ id: z.enum(ALL_SPOT_REFUSED_ORDER_TYPES), code: z.string().min(1) })),
});
export type SpotOrderTypes = z.infer<typeof spotOrderTypesSchema>;

/** The answer svc-trade serves when the own book is mounted, built from the lists above in the ticket's order. */
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

/** The market capabilities `venueSpotOrderTypes` reads from a listed venue spot market (`UserVenueMarket`). */
export interface VenueSpotMarketOrderCapabilities {
  readonly symbol: string;
  readonly kind: 'spot' | 'perpetual';
  readonly orderTypes: readonly string[];
  readonly timeInForce: readonly string[];
}

/**
 * The answer `GET /api/v1/order-types` serves when the user-venue door is on (J-cex-spot-15 #4): derived from the
 * venue's own spot market declaration, in the exact order `VenueSpotDesk.tsx` draws its ticket tabs (`limit`, `market`),
 * with the remaining types from `VENUE_SPOT_OTHER_ORDER_TYPES` listed as refused (`trade.venue.not_offered`) just as
 * `VenueOrderOptions.tsx` disables them.
 */
export function venueSpotOrderTypes(
  market: Pick<VenueSpotMarketOrderCapabilities, 'symbol' | 'orderTypes' | 'timeInForce'>,
): SpotOrderTypes {
  const offeredTypes = market.orderTypes.filter((id): id is VenueSpotOrderType => id === 'limit' || id === 'market');
  const venueTifs: readonly string[] = VENUE_SPOT_TIME_IN_FORCE;
  const offeredTifs = market.timeInForce.filter((t): t is VenueSpotTimeInForce => venueTifs.includes(t));
  const limitTifs: VenueSpotTimeInForce[] = offeredTifs.length > 0 ? offeredTifs : ['GTC'];
  const marketTif: VenueSpotTimeInForce = offeredTifs.includes('IOC') ? 'IOC' : (limitTifs[0] ?? 'IOC');

  const venueBase = (id: VenueSpotOrderType, timeInForce: VenueSpotTimeInForce) => ({
    kind: 'place_order',
    symbol: market.symbol,
    side: 'buy',
    type: id,
    amount: '0.001',
    price: '100',
    timeInForce,
    reduceOnly: false,
    builderFee: null,
    clientOrderKey: `TEST-example-${id}`,
  });

  return {
    source: 'venue',
    symbol: market.symbol,
    accepted: offeredTypes.map((id) =>
      id === 'limit'
        ? {
            id,
            send: {
              type: ['limit'],
              fields: ['price', 'timeInForce'],
              example: venueBase('limit', limitTifs[0] ?? 'GTC'),
            },
            timeInForce: [...limitTifs],
          }
        : {
            id,
            send: {
              type: ['market'],
              fields: ['price'],
              example: venueBase('market', marketTif),
            },
            timeInForce: [marketTif],
          },
    ),
    refused: VENUE_SPOT_OTHER_ORDER_TYPES.filter((id) => !market.orderTypes.includes(id)).map((id) => ({
      id,
      code: VENUE_SPOT_ORDER_TYPE_NOT_OFFERED,
    })),
  };
}
