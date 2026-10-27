/**
 * Every call the Futures and Margin rooms make, in one place, through the existing client. Nothing else in these
 * rooms touches `api.rest`. Money fields are exact decimal strings. Opens and closes are orders through the futures book
 * (`/futures/orders`): a price is sent only on a limit order, and a close is a reduce-only market order.
 *
 * Doors (services/svc-trade, VERIFIED 2026-10-17): see TRFUT-SPEC §0.
 */
import { z } from 'zod';
import { positionSchema } from '@intafaced/exchange-contract/schemas';
import type { ApiClient, ApiResult } from '../../../shared/api';
import { decimalSchema } from '../../../shared/money';
import { listingSchema } from '../../../features/trade/trade-api';
import { positionPreviewSchema } from '../../../features/trade/tool-api';

export const tickerStripSchema = z.object({
  markPrice: decimalSchema.nullable(),
  markSource: z.unknown().nullable().optional(),
  fundingRate: decimalSchema.nullable(),
  fundingPeriodId: z.string().nullable().optional(),
  nextFundingTime: z.string().nullable(),
});
export type TickerStrip = z.infer<typeof tickerStripSchema>;

export const fundingRateSchema = z.object({
  symbol: z.string(),
  markPrice: decimalSchema.nullable(),
  indexPrice: decimalSchema.nullable(),
  fundingRate: decimalSchema,
  fundingTimestamp: z.number(),
  fundingDatetime: z.string(),
  nextFundingTimestamp: z.number().nullable(),
});
export type FundingRate = z.infer<typeof fundingRateSchema>;

export const marginCallSchema = z.object({
  positionId: z.string(),
  sequence: z.number().int(),
  healthBps: z.number(),
  calledAt: z.string(),
  deliveredAt: z.string(),
  delivered: z.literal(true),
});
export type MarginCall = z.infer<typeof marginCallSchema>;

export const adlDisclosureSchema = z.object({ version: z.string(), copy: z.string(), acknowledged: z.boolean() });
export type AdlDisclosure = z.infer<typeof adlDisclosureSchema>;

export const adlEventSchema = z.object({
  eventId: z.string(),
  at: z.string(),
  version: z.string(),
  bankruptPositionId: z.string(),
  candidatePositionId: z.string(),
  sizeToReduce: decimalSchema,
  beforeAction: z.literal(true),
});
export type AdlEvent = z.infer<typeof adlEventSchema>;

/** What counts as futures margin for the account (`GET /futures/collateral`): cash with the haircut, and refused classes. */
export const collateralSchema = z.object({
  assets: z.array(
    z.object({
      asset: z.string(),
      collateralClass: z.literal('cash'),
      counts: z.literal(true),
      haircutBps: z.number().int().nullable(),
      haircutReason: z.string().nullable(),
      free: decimalSchema,
      posted: decimalSchema,
      committed: decimalSchema,
      credit: decimalSchema.nullable(),
      buyingPower: decimalSchema.nullable(),
      buyingPowerReason: z.string().nullable(),
    }),
  ),
  refusedClasses: z.array(
    z.object({ collateralClass: z.string(), counts: z.literal(false), code: z.string().nullable(), message: z.string().nullable() }),
  ),
});
export type Collateral = z.infer<typeof collateralSchema>;

/** The owner's maintenance tiers (`GET /futures/tiers`): the bound as a share of depth, and the notional it takes today. */
export const riskTiersSchema = z.object({
  symbol: z.string(),
  tiers: z.array(
    z.object({
      tier: z.number().int(),
      uptoDepthBps: z.number().int().nullable(),
      maintenanceBps: z.number().int(),
      maintenanceRate: decimalSchema,
      notionalUpto: z.object({ long: decimalSchema.nullable(), short: decimalSchema.nullable() }),
    }),
  ),
  depth: z.object({ long: decimalSchema.nullable(), short: decimalSchema.nullable() }),
  maxLeverage: decimalSchema.nullable(),
  leverageBasis: z.string(),
  formula: z.string(),
});
export type RiskTiers = z.infer<typeof riskTiersSchema>;

/** The margin and P&L calculator (`POST /futures/calculator`): arithmetic on typed inputs, nothing stored. */
export const calculatorSchema = z.object({
  symbol: z.string(),
  side: z.enum(['long', 'short']),
  size: decimalSchema,
  entryPrice: decimalSchema,
  exitPrice: decimalSchema.nullable(),
  leverage: decimalSchema,
  leverageCap: decimalSchema.nullable(),
  notional: decimalSchema,
  initialMargin: decimalSchema,
  tier: z.number().int().nullable(),
  maintenanceBps: z.number().int().nullable(),
  maintenanceMargin: decimalSchema.nullable(),
  liquidationPrice: decimalSchema.nullable(),
  pnl: decimalSchema.nullable(),
  roePercent: decimalSchema.nullable(),
  takerFeeBps: z.number().int().nullable(),
  entryFee: decimalSchema.nullable(),
  exitFee: decimalSchema.nullable(),
  netPnl: decimalSchema.nullable(),
  formulas: z.record(z.string(), z.string()),
  refusals: z.array(z.object({ code: z.string(), field: z.string(), message: z.string() })),
});
export type CalculatorResult = z.infer<typeof calculatorSchema>;

export interface CalculatorInput {
  symbol: string;
  side: 'long' | 'short';
  size: string;
  entryPrice: string;
  leverage: string;
  exitPrice?: string;
}

/** One futures order through the book (`POST /futures/orders`): an open, or a reduce-only close. */
/**
 * A take profit and stop loss attached to an opening order. The service arms them on the position once the order
 * fills, sized to what has filled, and grows them as more fills: waiting, armed (the order may fill more), done,
 * not_filled (it ended with no fill), no_position (nothing open on its side to protect) or not_placed (no order came).
 */
export const entryProtectionSchema = z.object({
  id: z.string(),
  symbol: z.string(),
  clientOrderId: z.string(),
  side: z.enum(['buy', 'sell']),
  takeProfit: decimalSchema.nullable(),
  stopLoss: decimalSchema.nullable(),
  status: z.enum(['waiting', 'armed', 'done', 'not_filled', 'no_position', 'not_placed']),
  armedQuantity: decimalSchema,
  takeProfitClientOrderId: z.string().nullable(),
  stopLossClientOrderId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type EntryProtection = z.infer<typeof entryProtectionSchema>;

export const futuresOrderSchema = z.object({
  orderId: z.string(),
  clientOrderId: z.string().optional(),
  marketId: z.string(),
  side: z.enum(['buy', 'sell']),
  type: z.enum(['limit', 'market']),
  qty: decimalSchema,
  limitPrice: decimalSchema,
  markPrice: decimalSchema,
  bandLow: decimalSchema,
  bandHigh: decimalSchema,
  holdAmount: decimalSchema,
  filledQty: decimalSchema,
  appliedAmount: decimalSchema,
  releasedAmount: decimalSchema,
  /** What the order's fills paid in trading fees from its hold. */
  feesPaid: decimalSchema.optional(),
  status: z.string(),
  refusalCode: z.string().nullable(),
  reduceOnly: z.boolean(),
  positionId: z.string().nullable(),
  bankruptcyPrice: decimalSchema.nullable(),
  symbol: z.string().optional(),
  createdAt: z.string().optional(),
  /** Present when the order asked for a take profit or stop loss. */
  protection: entryProtectionSchema.optional(),
});
export type FuturesOrder = z.infer<typeof futuresOrderSchema>;

/**
 * A futures conditional order: a stop, take-profit or trailing stop, or one leg of a position's take-profit and
 * stop-loss (`attachment`). Armed until the mark crosses its trigger; a fired one places a reduce-only order in the book
 * (`closeOrderId`) and keeps working until its size is closed.
 */
export const conditionalOrderSchema = z.object({
  id: z.string(),
  market: z.string(),
  kind: z.enum(['stop_market', 'stop_limit', 'take_profit', 'trailing_stop']),
  side: z.enum(['buy', 'sell']),
  quantity: decimalSchema,
  triggerPrice: decimalSchema.nullable(),
  limitPrice: decimalSchema.nullable(),
  /** A trailing stop's distance behind the best price its source reached (`trailExtreme`). */
  trailingDistance: decimalSchema.nullable().optional(),
  trailExtreme: decimalSchema.nullable().optional(),
  clientOrderId: z.string().optional(),
  positionId: z.string().nullable(),
  attachment: z.enum(['take_profit', 'stop_loss']).nullable(),
  /** A take profit or stop loss that closes the position as it is when it fires. Older answers carry none: whole. */
  wholePosition: z.boolean().optional(),
  status: z.enum(['armed', 'triggered', 'filled', 'cancelled', 'failed']),
  cancelReason: z.string().nullable(),
  failureReason: z.string().nullable(),
  /** The price a trigger is judged against. Older answers carry none: the published mark was the only source. */
  triggerSource: z.enum(['mark', 'last', 'index']).optional(),
  closeOrderId: z.string().nullable().optional(),
  firedQuantity: decimalSchema.nullable().optional(),
  closedQuantity: decimalSchema.nullable().optional(),
  createdAt: z.string(),
});
export type ConditionalOrder = z.infer<typeof conditionalOrderSchema>;

/** A stop that closes some or all of a position: its kind, the price it is judged on, and only the fields that kind takes. */
export interface StopInput {
  symbol: string;
  kind: 'stop_market' | 'stop_limit' | 'trailing_stop';
  /** The closing side: sell for a long, buy for a short. The service refuses one that would open or enlarge. */
  side: 'buy' | 'sell';
  quantity: string;
  triggerPrice?: string;
  limitPrice?: string;
  trailingDistance?: string;
  triggerSource: 'mark' | 'last' | 'index';
  clientOrderId: string;
}

export const protectionSchema = z.object({
  positionId: z.string(),
  takeProfit: conditionalOrderSchema.nullable(),
  stopLoss: conditionalOrderSchema.nullable(),
});
export type Protection = z.infer<typeof protectionSchema>;

export interface ProtectionInput {
  positionId: string;
  takeProfit: string | null;
  stopLoss: string | null;
  /** Part of the position this leg closes. Absent or null: the whole position. */
  takeProfitQuantity?: string | null;
  stopLossQuantity?: string | null;
  clientRequestId: string;
}

const legBody = (price: string, quantity: string | null | undefined) => (quantity ? { price, quantity } : price);

export const orderTypeEntrySchema = z.object({
  id: z.string(),
  state: z.enum(['available', 'refused']),
  code: z.string().optional(),
  reason: z.string().optional(),
});
export const orderTypeCatalogueSchema = z.object({
  markets: z.array(
    z.object({
      market: z.string(),
      orderTypes: z.array(orderTypeEntrySchema),
      timeInForce: z.array(orderTypeEntrySchema).optional(),
    }),
  ),
});
export type OrderTypeEntry = z.infer<typeof orderTypeEntrySchema>;
export type OrderTypeCatalogue = z.infer<typeof orderTypeCatalogueSchema>;

const blockerSchema = z.object({ code: z.string(), message: z.string() });
export const gatedListSchema = z.object({
  contracts: z.array(
    z.object({
      symbol: z.string(),
      marketId: z.string(),
      open: z.boolean(),
      code: z.string().nullable(),
      message: z.string().nullable(),
      blockers: z.array(blockerSchema),
    }),
  ),
});
export type GatedList = z.infer<typeof gatedListSchema>;

export type PositionPreview = z.infer<typeof positionPreviewSchema>;
export type FuturesListing = z.infer<typeof listingSchema>;

/** A futures listing the desk can offer: real (not paper) swap or dated future. */
export function isFuturesListing(listing: FuturesListing): boolean {
  return (listing.swap || listing.future) && !listing.paper;
}

export interface OpenInput {
  symbol: string;
  side: 'long' | 'short';
  size: string;
  leverage: string;
  /** Absent is cash. Another class is sent as chosen, and the service refuses it on its own code. */
  collateralClass?: string;
  /** Market (IOC up to the slippage cap or the band edge) or limit (rests GTC at `price`). */
  type: 'market' | 'limit';
  price?: string;
  /** A limit outside the price band is moved to the nearer edge instead of refused. Absent refuses it. */
  priceCorrection?: 'adjust';
  /** Above the max-order: placed as children of at most the cap (`POST /futures/orders/split`), keyed `<clientOpenId>:1..N`. */
  split?: true;
  /** A take profit and a stop loss attached to the order: they arm on what it fills (never with a split). */
  takeProfit?: string;
  stopLoss?: string;
  /** The margin tier the trader accepted in the confirm step; the service refuses a crossing into a tier not named. */
  confirmTier?: number;
  clientOpenId: string;
}

/**
 * One-tap reverse (J-derivatives-03 #9): one request closes the position through the book and opens the other side at
 * the same size and leverage. `closing` and `opening` are still working (the same request id sent again carries it on);
 * `closed_only` means the close stands and the open was refused or not sent, with `refusalCode`; never a silent half.
 */
export const reverseSchema = z.object({
  clientRequestId: z.string(),
  positionId: z.string(),
  symbol: z.string(),
  from: z.enum(['long', 'short']),
  to: z.enum(['long', 'short']),
  size: decimalSchema,
  leverage: decimalSchema,
  status: z.enum(['closing', 'opening', 'done', 'opened_part', 'closed_only', 'close_incomplete', 'refused']),
  closeClientOrderId: z.string(),
  openClientOrderId: z.string(),
  closeOrderId: z.string().nullable(),
  openOrderId: z.string().nullable(),
  closedQuantity: decimalSchema.nullable(),
  openedQuantity: decimalSchema.nullable(),
  newPositionId: z.string().nullable(),
  refusalCode: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Reverse = z.infer<typeof reverseSchema>;

export interface ReverseRequest {
  positionId: string;
  symbol: string;
  clientRequestId: string;
  /** The margin tier the trader accepted for the open in the review. */
  confirmTier?: number;
}

/** A reduce-only order from the ticket. A sell lowers a long and a buy lowers a short; with none open it is refused. */
export interface ReduceInput {
  symbol: string;
  side: 'buy' | 'sell';
  size: string;
  type: 'market' | 'limit';
  price?: string;
  priceCorrection?: 'adjust';
  clientOrderId: string;
}

export interface PlaceOrderInput {
  symbol: string;
  side: 'buy' | 'sell';
  type: 'market' | 'limit';
  amount: string;
  price?: string;
  leverage?: string;
  reduceOnly?: boolean;
  clientOrderId: string;
  collateralClass?: string;
  priceCorrection?: 'adjust';
  confirmTier?: number;
  takeProfit?: string;
  stopLoss?: string;
}

/** What the review asks: the form as it would be sent, so the band, the slippage cap and the split are this order's own. */
export interface PreviewInput {
  symbol: string;
  side: 'long' | 'short';
  size: string;
  leverage: string;
  collateralClass?: string;
  type?: 'market' | 'limit';
  limitPrice?: string;
  priceCorrection?: 'adjust';
}

export const futuresSplitSchema = z.object({
  parts: z.number().int(),
  orders: z.array(futuresOrderSchema),
  /** The child a typed refusal stopped at; the children before it are live. */
  stopped: z.object({ child: z.number().int(), code: z.string(), message: z.string() }).nullable(),
});
export type FuturesSplit = z.infer<typeof futuresSplitSchema>;

export function createFuturesApi(api: ApiClient) {
  return {
    markets: (signal?: AbortSignal) => api.rest('/markets', z.array(listingSchema), { query: { limit: 500 }, signal }),
    ticker: (symbol: string, signal?: AbortSignal) => api.rest('/futures/ticker', tickerStripSchema, { query: { symbol }, signal }),
    fundingRate: (symbol: string, signal?: AbortSignal) =>
      api.rest(`/funding-rate/${encodeURIComponent(symbol)}`, fundingRateSchema, { signal }),
    preview: (input: PreviewInput, signal?: AbortSignal) =>
      api.rest('/positions/preview', positionPreviewSchema, { method: 'POST', body: { ...input, marginMode: 'isolated' }, signal }),
    collateral: (signal?: AbortSignal) => api.rest('/futures/collateral', collateralSchema, { signal }),
    tiers: (symbol: string, signal?: AbortSignal) => api.rest('/futures/tiers', riskTiersSchema, { query: { symbol }, signal }),
    calculate: (input: CalculatorInput) =>
      api.rest('/futures/calculator', calculatorSchema, { method: 'POST', body: { ...input, marginMode: 'isolated' } }),
    /** Futures orders go through the book (futures ADR): an open is an order, a close is a reduce-only order. */
    placeOrder: (input: PlaceOrderInput) =>
      api.rest('/futures/orders', futuresOrderSchema, { method: 'POST', body: { ...input, marginMode: 'isolated' } }),
    /** An opening order above the max-order as children of at most the cap; the same request again places none twice. */
    placeSplit: (input: PlaceOrderInput) =>
      api.rest('/futures/orders/split', futuresSplitSchema, { method: 'POST', body: { ...input, marginMode: 'isolated' } }),
    cancelOrder: (orderId: string) => api.rest(`/futures/orders/${encodeURIComponent(orderId)}`, futuresOrderSchema, { method: 'DELETE' }),
    orders: (scope: 'open' | 'all', signal?: AbortSignal) =>
      api.rest('/futures/orders', z.array(futuresOrderSchema), { query: { scope, limit: 100 }, signal }),
    /** Every recent order on one contract, up to the service's page cap: where a split's children are looked up. */
    ordersOn: (symbol: string) => api.rest('/futures/orders', z.array(futuresOrderSchema), { query: { scope: 'all', limit: 500, symbol } }),
    orderTypes: (signal?: AbortSignal) => api.rest('/futures/order-types', orderTypeCatalogueSchema, { query: { limit: 50 }, signal }),
    gatedList: (signal?: AbortSignal) => api.rest('/account/gated-list', gatedListSchema, { signal }),
    positions: (signal?: AbortSignal) => api.rest('/positions', z.array(positionSchema), { signal }),
    closed: (signal?: AbortSignal) => api.rest('/positions/closed', z.array(positionSchema), { query: { limit: 100 }, signal }),
    position: (id: string, signal?: AbortSignal) => api.rest(`/positions/${encodeURIComponent(id)}`, positionSchema, { signal }),
    close: (id: string, input: { quantity: string; clientCloseId: string }) =>
      api.rest(`/positions/${encodeURIComponent(id)}/close`, positionSchema, {
        method: 'POST',
        body: { quantity: input.quantity, clientCloseId: input.clientCloseId },
      }),
    setLeverage: (input: { symbol: string; positionId: string; leverage: string; clientAdjustmentId: string }) =>
      api.rest('/futures/leverage', positionSchema, { method: 'POST', body: input }),
    addMargin: (input: { symbol: string; positionId: string; amount: string; clientAdjustmentId: string }) =>
      api.rest('/positions/margin', positionSchema, { method: 'POST', body: { ...input, collateralClass: 'cash' } }),
    reduceMargin: (input: { symbol: string; positionId: string; amount: string; clientAdjustmentId: string }) =>
      api.rest('/positions/margin/reduce', positionSchema, { method: 'POST', body: input }),
    conditionalOrders: async (signal?: AbortSignal): Promise<ApiResult<ConditionalOrder[]>> => {
      const read = await api.rest('/futures/conditional-orders', z.object({ orders: z.array(conditionalOrderSchema) }), { signal });
      return read.ok ? { ...read, data: read.data.orders } : read;
    },
    /** Every take profit and stop loss attached to an opening order: waiting, armed, and the newest finished. */
    entryProtections: async (signal?: AbortSignal): Promise<ApiResult<EntryProtection[]>> => {
      const read = await api.rest('/futures/entry-protection', z.object({ protections: z.array(entryProtectionSchema) }), { signal });
      return read.ok ? { ...read, data: read.data.protections } : read;
    },
    conditionalOrder: (id: string, signal?: AbortSignal) =>
      api.rest(`/futures/conditional-orders/${encodeURIComponent(id)}`, conditionalOrderSchema, { signal }),
    /** Reverse a position: the same request id carries a working reverse on, or answers how it ended. */
    reverse: (input: ReverseRequest) =>
      api.rest(`/positions/${encodeURIComponent(input.positionId)}/reverse`, reverseSchema, {
        method: 'POST',
        body: { clientRequestId: input.clientRequestId, ...(input.confirmTier !== undefined ? { confirmTier: input.confirmTier } : {}) },
      }),
    /** Arm one stop. The same client id replays the order already armed under it. */
    createConditional: (input: StopInput) =>
      api.rest('/futures/conditional-orders', conditionalOrderSchema, {
        method: 'POST',
        body: {
          market: input.symbol,
          kind: input.kind,
          side: input.side,
          quantity: input.quantity,
          ...(input.triggerPrice !== undefined ? { triggerPrice: input.triggerPrice } : {}),
          ...(input.limitPrice !== undefined ? { limitPrice: input.limitPrice } : {}),
          ...(input.trailingDistance !== undefined ? { trailingDistance: input.trailingDistance } : {}),
          reduceOnly: true,
          triggerSource: input.triggerSource,
          clientOrderId: input.clientOrderId,
        },
      }),
    /** Cancel one armed order. One that already fired or ended answers with the service's refusal. */
    cancelConditional: (id: string) =>
      api.rest(`/futures/conditional-orders/${encodeURIComponent(id)}`, conditionalOrderSchema, { method: 'DELETE' }),
    /**
     * Replace a position's take-profit and stop-loss. A missing price clears that leg; a quantity covers that part of
     * the position, none the whole of it. The same request id replays.
     */
    setProtection: (input: ProtectionInput) =>
      api.rest(`/positions/${encodeURIComponent(input.positionId)}/protection`, protectionSchema, {
        method: 'PUT',
        body: {
          ...(input.takeProfit ? { takeProfit: legBody(input.takeProfit, input.takeProfitQuantity) } : {}),
          ...(input.stopLoss ? { stopLoss: legBody(input.stopLoss, input.stopLossQuantity) } : {}),
          clientRequestId: input.clientRequestId,
        },
      }),
    marginCall: (positionId: string, signal?: AbortSignal) =>
      api.rest(`/positions/${encodeURIComponent(positionId)}/margin-call`, marginCallSchema, { signal }),
    adlDisclosure: (signal?: AbortSignal) => api.rest('/futures/adl-disclosure', adlDisclosureSchema, { signal }),
    adlEvents: (signal?: AbortSignal) => api.rest('/futures/adl-events', z.array(adlEventSchema), { query: { limit: 100 }, signal }),
  };
}
export type FuturesApi = ReturnType<typeof createFuturesApi>;
