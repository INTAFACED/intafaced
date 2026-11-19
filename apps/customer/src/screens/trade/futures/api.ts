/**
 * Every call the Futures and Margin rooms make, in one place, through the existing client. Nothing else in these
 * rooms touches `api.rest`. Money fields are exact decimal strings. Opens and closes are orders through the futures book
 * (`/futures/orders`): a price is sent only on a limit order, and a close is a reduce-only market order.
 *
 * Doors (services/svc-trade, VERIFIED 2026-10-17): see TRFUT-SPEC §0.
 */
import { z } from 'zod';
import { positionSchema } from '@intafaced/exchange-contract/schemas';
import {
  conditionalOrderListSchema,
  entryProtectionListSchema,
  adlDisclosureSchema,
  adlEventSchema,
  calculatorSchema,
  collateralSchema,
  conditionalOrderSchema,
  fundingRateSchema,
  futuresExecutionPageSchema,
  futuresOrderSchema,
  futuresSplitSchema,
  gatedListSchema,
  marginCallSchema,
  marginSummarySchema,
  orderTypeCatalogueSchema,
  protectionSchema,
  reverseSchema,
  riskStopSchema,
  riskTiersSchema,
  tickerStripSchema,
  type ConditionalOrder,
  type EntryProtection,
} from '@intafaced/contracts/trade-futures-room';
import type { ApiClient, ApiResult } from '../../../shared/api';
import { listingSchema } from '../../../features/trade/trade-api';
import { positionPreviewSchema } from '../../../features/trade/tool-api';

export {
  tickerStripSchema,
  fundingRateSchema,
  marginCallSchema,
  riskStopSchema,
  adlDisclosureSchema,
  adlEventSchema,
  collateralSchema,
  marginSummarySchema,
  riskTiersSchema,
  calculatorSchema,
  entryProtectionSchema,
  ORDER_LABEL,
  FUTURES_ORDER_ORIGINS,
  FUTURES_EXECUTION_KINDS,
  futuresOrderSchema,
  futuresExecutionSchema,
  futuresExecutionPageSchema,
  conditionalOrderSchema,
  protectionSchema,
  orderTypeEntrySchema,
  orderTypeCatalogueSchema,
  gatedListSchema,
  reverseSchema,
  futuresSplitSchema,
} from '@intafaced/contracts/trade-futures-room';
export type {
  TickerStrip,
  FundingRate,
  MarginCall,
  RiskStop,
  AdlDisclosure,
  AdlEvent,
  Collateral,
  MarginSummary,
  RiskTiers,
  CalculatorResult,
  EntryProtection,
  FuturesOrder,
  FuturesOrderOrigin,
  FuturesExecution,
  ConditionalOrder,
  Protection,
  OrderTypeEntry,
  OrderTypeCatalogue,
  GatedList,
  Reverse,
  FuturesSplit,
} from '@intafaced/contracts/trade-futures-room';

export interface RiskStopInput {
  symbol: string;
  positionId: string;
  /** A percent of margin ratio as a decimal string; null clears the stop. */
  level: string | null;
  clientRequestId: string;
}

export interface CalculatorInput {
  symbol: string;
  side: 'long' | 'short';
  size: string;
  entryPrice: string;
  leverage: string;
  exitPrice?: string;
}

/** A page of the trader's futures orders, as the orders room asks for it. */
export interface FuturesOrderQuery {
  scope: 'open' | 'history' | 'all';
  limit: number;
  symbol?: string;
  label?: string;
  origin?: string;
  before?: string;
}

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
  /** The trader's own tag on the order. */
  orderLabel?: string;
  /** The margin tier the trader accepted in the confirm step; the service refuses a crossing into a tier not named. */
  confirmTier?: number;
  clientOpenId: string;
}

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
  orderLabel?: string;
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
  /** The trader's own tag, 1 to 36 of letters, digits and . _ : - */
  orderLabel?: string;
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

export function createFuturesApi(api: ApiClient) {
  return {
    markets: (signal?: AbortSignal) => api.rest('/markets', z.array(listingSchema), { query: { limit: 500 }, signal }),
    ticker: (symbol: string, signal?: AbortSignal) => api.rest('/futures/ticker', tickerStripSchema, { query: { symbol }, signal }),
    fundingRate: (symbol: string, signal?: AbortSignal) =>
      api.rest(`/funding-rate/${encodeURIComponent(symbol)}`, fundingRateSchema, { signal }),
    preview: (input: PreviewInput, signal?: AbortSignal) =>
      api.rest('/positions/preview', positionPreviewSchema, { method: 'POST', body: { ...input, marginMode: 'isolated' }, signal }),
    collateral: (signal?: AbortSignal) => api.rest('/futures/collateral', collateralSchema, { signal }),
    marginSummary: (asset: string, signal?: AbortSignal) =>
      api.rest('/futures/margin-summary', marginSummarySchema, { query: { asset }, signal }),
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
    /** A page of the trader's orders, newest first; `before` is the last order of the page before. */
    orderPage: (query: FuturesOrderQuery, signal?: AbortSignal) =>
      api.rest('/futures/orders', z.array(futuresOrderSchema), { query: { ...query }, signal }),
    order: (orderId: string, signal?: AbortSignal) =>
      api.rest(`/futures/orders/${encodeURIComponent(orderId)}`, futuresOrderSchema, { signal }),
    executions: (query: { limit: number; symbol?: string; kind?: string; orderId?: string; before?: string }, signal?: AbortSignal) =>
      api.rest('/futures/executions', futuresExecutionPageSchema, { query: { ...query }, signal }),
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
      const read = await api.rest('/futures/conditional-orders', conditionalOrderListSchema, { signal });
      return read.ok ? { ...read, data: read.data.orders } : read;
    },
    /** Every take profit and stop loss attached to an opening order: waiting, armed, and the newest finished. */
    entryProtections: async (signal?: AbortSignal): Promise<ApiResult<EntryProtection[]>> => {
      const read = await api.rest('/futures/entry-protection', entryProtectionListSchema, { signal });
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
    riskStop: (positionId: string, signal?: AbortSignal) =>
      api.rest(`/positions/${encodeURIComponent(positionId)}/risk-stop`, riskStopSchema, { signal }),
    /** Set or clear a position's pre-liquidation stop. The same request id answers with the stop as it stands. */
    setRiskStop: (input: RiskStopInput) =>
      api.rest(`/positions/${encodeURIComponent(input.positionId)}/risk-stop`, riskStopSchema, {
        method: 'PUT',
        body: { level: input.level, clientRequestId: input.clientRequestId },
      }),
    marginCall: (positionId: string, signal?: AbortSignal) =>
      api.rest(`/positions/${encodeURIComponent(positionId)}/margin-call`, marginCallSchema, { signal }),
    adlDisclosure: (signal?: AbortSignal) => api.rest('/futures/adl-disclosure', adlDisclosureSchema, { signal }),
    adlEvents: (signal?: AbortSignal) => api.rest('/futures/adl-events', z.array(adlEventSchema), { query: { limit: 100 }, signal }),
  };
}
export type FuturesApi = ReturnType<typeof createFuturesApi>;
