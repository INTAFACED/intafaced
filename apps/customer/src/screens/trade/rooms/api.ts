/**
 * Every call the Options, Execution and Quote desk rooms make, with the shape each answer must have.
 * Money stays an exact decimal string. A shape that does not match is a refusal (`invalid_response`), never a guess.
 * The legacy rooms in features/trade/tool-api.ts already made the algo and RFQ calls; their schemas are reused here
 * and extended only where the live service sends more than they read.
 */
import { z } from 'zod';
import { decimalSchema } from '../../../shared/money';
import {
  algoParentFields,
  algoResultSchema,
  algoListSchema,
  algoPolicySchema,
  otcMakersSchema,
  deskStatusSchema,
  rfqBoardSchema,
  convertBoundsSchema,
  optionsPolicySchema,
  greeksSchema,
  batchSchema,
  icebergAnswerSchema,
  previewSizesSchema,
} from '@intafaced/contracts/trade-rooms';
import type { ApiClient } from '../../../shared/api';
import { algoSchema, otcFillSchema, otcQuoteSchema } from '../../../features/trade/tool-api';
import { listingSchema } from '../../../features/trade/trade-api';
import { TRADE_ALGO_PROGRESS, TRADE_ALGO_PREVIEW_TWAP_SIZES, TRADE_ALGO_RESULT } from '@intafaced/contracts/trade-algo-procedures';
import { TRADE_OTC_MAKERS_LIST, TRADE_OTC_SETTLE, TRADE_OTC_CONVERT_BOUNDS } from '@intafaced/contracts/trade-otc-procedures';
import { TRADE_RFQ_GET, TRADE_RFQ_ACCEPT, TRADE_RFQ_EXPIRE } from '@intafaced/contracts/trade-rfq-procedures';
import { type ProcedureOutput } from '@intafaced/contracts/procedure';

export { otcFillSchema, otcQuoteSchema };
export {
  algoResultSchema,
  algoListSchema,
  algoPolicySchema,
  otcMakersSchema,
  deskStatusSchema,
  rfqBoardSchema,
  convertBoundsSchema,
  optionsPolicySchema,
  greeksSchema,
  batchItemSchema,
  batchSchema,
  icebergAnswerSchema,
  previewSizesSchema,
} from '@intafaced/contracts/trade-rooms';
export type {
  AlgoResult,
  AlgoListPage,
  AlgoPolicy,
  OtcMakers,
  DeskStatus,
  RfqBoard,
  RfqBoardStatus,
  ConvertBounds,
  OptionsPolicy,
  GreeksAnswer,
  BatchItem,
} from '@intafaced/contracts/trade-rooms';

/** `algo.get` also sends the schedule clock and the participation rate; the legacy schema drops them. */
export const algoParentSchema = algoSchema.extend(algoParentFields);
export type PovBasis = 'traded_volume' | 'opposite_liquidity';

/** Schedules the room lists at a time. The service refuses a list read without a limit. */
export const ALGO_LIST_PAGE = 50;
export type AlgoParent = z.infer<typeof algoParentSchema>;
export type AlgoProgress = ProcedureOutput<typeof TRADE_ALGO_PROGRESS>;

/** `otc.convertQuote`: a desk quote for a conversion, with the owner's settle window (null when blank). */
export const otcConvertQuoteSchema = otcQuoteSchema.extend({
  flow: z.enum(['convert', 'oneClickBuy']),
  settleWindowMs: z.number().int().nullable(),
});
export type OtcConvertQuote = z.infer<typeof otcConvertQuoteSchema>;
export type RfqQuote = z.infer<typeof otcQuoteSchema>;
export type RfqFill = z.infer<typeof otcFillSchema> & { fillId: string; takerOrderId: string; makerOrderId: string };

/** A `/markets` row, with the option terms the contract carries for kind=option. */
export const listedMarketSchema = listingSchema.extend({
  optionType: z.enum(['call', 'put']).nullish(),
  strike: decimalSchema.nullish(),
  expiryDatetime: z.string().nullish(),
  contractSize: decimalSchema.nullish(),
});
export type ListedMarket = z.infer<typeof listedMarketSchema>;

export interface IcebergOrder {
  symbol: string;
  side: 'buy' | 'sell';
  amount: string;
  price: string;
  displayQty: string;
  clientOrderId: string;
  /** A listed lead's Lead trade switch: an iceberg is never a lead trade, so a lead always sends false (CB-copy-14). */
  lead?: false;
}

export interface CreateTwapInput {
  symbol: string;
  side: 'buy' | 'sell';
  totalQty: string;
  durationMs: number;
  sliceIntervalMs: number;
  kind: 'twap' | 'vwap' | 'pov' | 'chase';
  clientAlgoId: string;
  limitPrice?: string;
  participationBps?: number;
  /** POV only: traded volume (default) or opposite-side liquidity. */
  povBasis?: PovBasis;
  /** TWAP only: random slice sizes fixed by this seed. */
  randomSeed?: number;
  /** TWAP only: the schedule waits until the mark reaches this price. */
  triggerPrice?: string;
  /** Chase only, required: how far from its start price, in bps, the chase may follow the book. */
  chaseDistanceBps?: number;
}

export interface PreviewSizesInput {
  symbol: string;
  totalQty: string;
  durationMs: number;
  sliceIntervalMs: number;
  randomSeed?: number;
}

export interface BatchOrder {
  symbol: string;
  type: 'limit';
  side: 'buy' | 'sell';
  amount: string;
  price: string;
  timeInForce: 'GTC' | 'PO';
  postOnly?: boolean;
  clientOrderId: string;
}

export interface GreeksInput {
  right: 'call' | 'put';
  spot: string;
  strike: string;
  volatility: string;
  timeToExpiry: string;
  riskFreeRate: string;
  dividendYield: string;
}

export function createRoomApi(api: ApiClient) {
  return {
    algoPolicy: (signal?: AbortSignal) => api.query('trade', 'algo.policy', undefined, algoPolicySchema, { signal }),
    algoCreate: (input: CreateTwapInput) => api.mutate('trade', 'algo.createTwap', input, algoParentSchema),
    algoGet: (algoId: string, signal?: AbortSignal) => api.query('trade', 'algo.get', { algoId }, algoParentSchema, { signal }),
    algoPreviewSizes: (input: PreviewSizesInput) => api.call(TRADE_ALGO_PREVIEW_TWAP_SIZES, input),
    algoResult: (algoId: string, signal?: AbortSignal) => api.call(TRADE_ALGO_RESULT, { algoId }, { signal }),
    algoList: (signal?: AbortSignal) => api.query('trade', 'algo.list', { limit: ALGO_LIST_PAGE }, algoListSchema, { signal }),
    algoProgress: (algoId: string, signal?: AbortSignal) => api.call(TRADE_ALGO_PROGRESS, { algoId }, { signal }),
    algoAction: (action: 'pause' | 'resume' | 'cancel', algoId: string) =>
      api.mutate('trade', `algo.${action}`, { algoId }, algoParentSchema),
    deskStatus: (signal?: AbortSignal) => api.query('trade', 'otc.deskStatus', undefined, deskStatusSchema, { signal }),
    otcMakers: (signal?: AbortSignal) => api.call(TRADE_OTC_MAKERS_LIST, undefined, { signal }),
    otcConvertBounds: (signal?: AbortSignal) => api.call(TRADE_OTC_CONVERT_BOUNDS, undefined, { signal }),
    otcConvertQuote: (input: { flow: 'convert'; side: 'buy' | 'sell'; baseAsset: string; quoteAsset: string; qty: string }) =>
      api.mutate('trade', 'otc.convertQuote', input, otcConvertQuoteSchema),
    rfqQuote: (input: { side: 'buy' | 'sell'; baseAsset: string; quoteAsset: string; qty: string; makerIds: string[]; makerId?: string }) =>
      api.mutate('trade', 'rfq.quote', input, otcQuoteSchema),
    rfqGet: (quoteId: string, signal?: AbortSignal) => api.call(TRADE_RFQ_GET, { quoteId }, { signal }),
    rfqBoard: (window: { from: string; to: string; limit: number }, signal?: AbortSignal) =>
      api.query('trade', 'rfq.board', window, rfqBoardSchema, { signal }),
    /** `assertedPrice` can only cause a refusal (last look is forbidden); it never sets the fill price. */
    rfqAccept: (quoteId: string, assertedPrice: string) => api.call(TRADE_RFQ_ACCEPT, { quoteId, assertedPrice }),
    rfqExpire: (quoteId: string) => api.call(TRADE_RFQ_EXPIRE, { quoteId }),
    otcSettle: (quoteId: string) => api.call(TRADE_OTC_SETTLE, { quoteId }),
    optionsPolicy: (signal?: AbortSignal) => api.query('trade', 'options.policy', undefined, optionsPolicySchema, { signal }),
    markets: (signal?: AbortSignal) => api.rest('/markets', z.array(listedMarketSchema), { query: { limit: 500 }, signal }),
    greeks: (input: GreeksInput, signal?: AbortSignal) =>
      api.rest('/greeks/what-if', greeksSchema, { method: 'POST', body: input, signal }),
    placeBatch: (orders: BatchOrder[]) => api.rest('/orders/batch', batchSchema, { method: 'POST', body: { orders } }),
    /** One of the account's orders by its request id; `trade.order_not_found` when no order was made with it. */
    orderByClientId: (clientOrderId: string, symbol: string) =>
      api.rest(
        `/orders/by-client-id/${encodeURIComponent(clientOrderId)}`,
        icebergAnswerSchema.extend({ executionOutcome: z.unknown().nullable().optional() }),
        { query: { symbol } },
      ),
    placeIceberg: (order: IcebergOrder) =>
      api.rest('/orders', icebergAnswerSchema, { method: 'POST', body: { ...order, type: 'limit', timeInForce: 'GTC' } }),
  };
}
export type RoomApi = ReturnType<typeof createRoomApi>;
