/**
 * Every call the Options, Execution and Quote desk rooms make, with the shape each answer must have.
 * Money stays an exact decimal string. A shape that does not match is a refusal (`invalid_response`), never a guess.
 * The legacy rooms in features/trade/tool-api.ts already made the algo and RFQ calls; their schemas are reused here
 * and extended only where the live service sends more than they read.
 */
import { z } from 'zod';
import { decimalSchema, signedDecimalSchema } from '../../../shared/money';
import type { ApiClient } from '../../../shared/api';
import { algoProgressSchema, algoSchema, otcFillSchema, otcQuoteSchema } from '../../../features/trade/tool-api';
import { listingSchema } from '../../../features/trade/trade-api';

export { algoProgressSchema, otcFillSchema, otcQuoteSchema };

/** `algo.get` also sends the schedule clock and the participation rate; the legacy schema drops them. */
export const algoParentSchema = algoSchema.extend({
  kind: z.enum(['twap', 'vwap', 'pov', 'chase']),
  participationBps: z.number().int().nullable().optional(),
  povBasis: z.enum(['traded_volume', 'opposite_liquidity']).nullable().optional(),
  startedAt: z.string().nullable().optional(),
  nextDueAt: z.string().nullable().optional(),
  scheduleStretchReason: z.string().nullable().optional(),
  randomSeed: z.number().int().nullable().optional(),
  triggerPrice: decimalSchema.nullable().optional(),
  triggeredAt: z.string().nullable().optional(),
  awaitingTrigger: z.boolean().optional(),
  plannedSliceQtys: z.array(decimalSchema).optional(),
  /** Chase: the bound, the own-side best price it started from, the newest child's price and how often it re-priced. */
  chaseMaxDistanceBps: z.number().int().nullable().optional(),
  chaseStartPrice: decimalSchema.nullable().optional(),
  chasePrice: decimalSchema.nullable().optional(),
  chaseReprices: z.number().int().nullable().optional(),
  /** `algo.get` children: each placed size and, for POV, the volume or book size it was a share of; a chase child's price. */
  children: z
    .array(
      z.object({
        sliceIndex: z.number().int(),
        qty: decimalSchema.optional(),
        basisQty: decimalSchema.nullable().optional(),
        price: decimalSchema.nullable().optional(),
      }),
    )
    .optional(),
});
export type PovBasis = 'traded_volume' | 'opposite_liquidity';

/** `algo.result`: per quote asset, the average price of the real child fills — null while nothing has filled. */
export const algoResultSchema = z.object({
  quotes: z.array(z.object({ quoteAsset: z.string(), filledQty: decimalSchema, averageFillPrice: decimalSchema.nullable() })),
});
export type AlgoResult = z.infer<typeof algoResultSchema>;

/** `algo.list`: the person's schedules as the service keeps them, newest first, so every browser shows the same list. */
export const algoListSchema = z.object({ rows: z.array(z.object({ id: z.string() })), nextCursor: z.string().nullable() });
export type AlgoListPage = z.infer<typeof algoListSchema>;
/** Schedules the room lists at a time. The service refuses a list read without a limit. */
export const ALGO_LIST_PAGE = 50;
export type AlgoParent = z.infer<typeof algoParentSchema>;
export type AlgoProgress = z.infer<typeof algoProgressSchema>;

export const algoPolicySchema = z.object({
  productKind: z.string(),
  capability: z.object({ createEnabled: z.boolean(), jobsEnabled: z.boolean(), icebergs: z.string() }),
  immatureKinds: z.array(z.string()),
  volumeImmatureCode: z.string(),
  cancelIncompleteCode: z.string(),
});
export type AlgoPolicy = z.infer<typeof algoPolicySchema>;

/** `otc.makers.list` (CB-otc-01): the owner's provider list and pick cap, or the honest empty state. */
export const otcMakersSchema = z.object({
  published: z.boolean(),
  makers: z.array(z.object({ id: z.string(), name: z.string(), route: z.enum(['platform', 'outside']) })),
  selectCap: z.number().int().nullable(),
  emptyLabel: z.string().nullable(),
});
export type OtcMakers = z.infer<typeof otcMakersSchema>;

export const deskStatusSchema = z.object({
  published: z.boolean(),
  statusLine: z.string(),
  residual: z.string().nullable().optional(),
  makerRouting: z.object({ published: z.boolean(), residual: z.string().nullable().optional() }).optional(),
  midFeed: z.object({ wiring: z.string(), published: z.boolean(), residual: z.string().nullable().optional() }).optional(),
});
export type DeskStatus = z.infer<typeof deskStatusSchema>;
export type RfqQuote = z.infer<typeof otcQuoteSchema>;
export type RfqFill = z.infer<typeof otcFillSchema> & { fillId: string; takerOrderId: string; makerOrderId: string };

export const optionsPolicySchema = z.object({
  settlementAssetLawStamped: z.boolean(),
  settlementFixingConfigured: z.boolean(),
  blockers: z.array(z.string()),
  residual: z.string(),
  statusLine: z.string(),
  allowed: z.object({ optionsOrders: z.boolean(), paperOptionsOrders: z.boolean(), liveOptionsOrders: z.boolean() }),
  europeanOnly: z.boolean(),
  fullCollateralV1: z.boolean(),
});
export type OptionsPolicy = z.infer<typeof optionsPolicySchema>;

/** A `/markets` row, with the option terms the contract carries for kind=option. */
export const listedMarketSchema = listingSchema.extend({
  optionType: z.enum(['call', 'put']).nullish(),
  strike: decimalSchema.nullish(),
  expiryDatetime: z.string().nullish(),
  contractSize: decimalSchema.nullish(),
});
export type ListedMarket = z.infer<typeof listedMarketSchema>;

export const greeksSchema = z.union([
  // Greeks are signed: a put delta and a long option's theta are negative.
  z.object({
    ok: z.literal(true),
    npv: signedDecimalSchema,
    delta: signedDecimalSchema,
    gamma: signedDecimalSchema,
    vega: signedDecimalSchema,
    theta: signedDecimalSchema,
  }),
  z.object({ ok: z.literal(false), code: z.string(), message: z.string(), field: z.string().optional() }),
]);
export type GreeksAnswer = z.infer<typeof greeksSchema>;

/** One item of `POST /orders/batch`: the service answers each order on its own, and never rolls the group back. */
export const batchItemSchema = z.object({
  index: z.number().int(),
  clientOrderId: z.string().nullable(),
  status: z.enum(['success', 'refused', 'unknown']),
  order: z.object({ id: z.string(), status: z.string() }).passthrough().optional(),
  error: z.object({ message: z.string(), intafacedCode: z.string().optional() }).passthrough().optional(),
});
export type BatchItem = z.infer<typeof batchItemSchema>;
export const batchSchema = z.object({ results: z.array(batchItemSchema) });

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
export const previewSizesSchema = z.object({ sliceQtys: z.array(decimalSchema) });

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
    algoPreviewSizes: (input: PreviewSizesInput) => api.query('trade', 'algo.previewTwapSizes', input, previewSizesSchema),
    algoResult: (algoId: string, signal?: AbortSignal) => api.query('trade', 'algo.result', { algoId }, algoResultSchema, { signal }),
    algoList: (signal?: AbortSignal) => api.query('trade', 'algo.list', { limit: ALGO_LIST_PAGE }, algoListSchema, { signal }),
    algoProgress: (algoId: string, signal?: AbortSignal) => api.query('trade', 'algo.progress', { algoId }, algoProgressSchema, { signal }),
    algoAction: (action: 'pause' | 'resume' | 'cancel', algoId: string) =>
      api.mutate('trade', `algo.${action}`, { algoId }, algoParentSchema),
    deskStatus: (signal?: AbortSignal) => api.query('trade', 'otc.deskStatus', undefined, deskStatusSchema, { signal }),
    otcMakers: (signal?: AbortSignal) => api.query('trade', 'otc.makers.list', undefined, otcMakersSchema, { signal }),
    rfqQuote: (input: { side: 'buy' | 'sell'; baseAsset: string; quoteAsset: string; qty: string; makerIds: string[]; makerId?: string }) =>
      api.mutate('trade', 'rfq.quote', input, otcQuoteSchema),
    rfqGet: (quoteId: string, signal?: AbortSignal) => api.query('trade', 'rfq.get', { quoteId }, otcQuoteSchema, { signal }),
    /** `assertedPrice` can only cause a refusal (last look is forbidden); it never sets the fill price. */
    rfqAccept: (quoteId: string, assertedPrice: string) => api.mutate('trade', 'rfq.accept', { quoteId, assertedPrice }, otcQuoteSchema),
    rfqExpire: (quoteId: string) => api.mutate('trade', 'rfq.expire', { quoteId }, otcQuoteSchema),
    otcSettle: (quoteId: string) =>
      api.mutate(
        'trade',
        'otc.settle',
        { quoteId },
        otcFillSchema.extend({ fillId: z.string(), takerOrderId: z.string(), makerOrderId: z.string() }),
      ),
    optionsPolicy: (signal?: AbortSignal) => api.query('trade', 'options.policy', undefined, optionsPolicySchema, { signal }),
    markets: (signal?: AbortSignal) => api.rest('/markets', z.array(listedMarketSchema), { query: { limit: 500 }, signal }),
    greeks: (input: GreeksInput, signal?: AbortSignal) =>
      api.rest('/greeks/what-if', greeksSchema, { method: 'POST', body: input, signal }),
    placeBatch: (orders: BatchOrder[]) => api.rest('/orders/batch', batchSchema, { method: 'POST', body: { orders } }),
  };
}
export type RoomApi = ReturnType<typeof createRoomApi>;
