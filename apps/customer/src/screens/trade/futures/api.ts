/**
 * Every call the Futures and Margin rooms make, in one place, through the existing client. Nothing else in these
 * rooms touches `api.rest`. Money fields are exact decimal strings. Opens and closes are orders through the futures book
 * (`/futures/orders`): a price is sent only on a limit order, and a close is a reduce-only market order.
 *
 * Doors (services/svc-trade, VERIFIED 2026-10-17): see TRFUT-SPEC §0.
 */
import { z } from 'zod';
import { positionSchema } from '@intafaced/exchange-contract/schemas';
import type { ApiClient } from '../../../shared/api';
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

/** One futures order through the book (`POST /futures/orders`): an open, or a reduce-only close. */
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
});
export type FuturesOrder = z.infer<typeof futuresOrderSchema>;

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

export const agreementSchema = z.union([
  z.object({
    kind: z.string(),
    available: z.literal(true),
    version: z.number().int(),
    textId: z.string(),
    region: z.string(),
    title: z.string(),
    body: z.string(),
    accepted: z.boolean(),
    acceptedAt: z.string().nullable(),
  }),
  z.object({ kind: z.string(), available: z.literal(false), reason: z.string(), message: z.string() }),
]);
export const agreementsSchema = z.object({ agreements: z.array(agreementSchema) });
export type Agreement = z.infer<typeof agreementSchema>;

export const eligibilitySchema = z.object({
  state: z.object({
    status: z.string(),
    reason: z.string().nullable().optional(),
    ruleVersion: z.number().nullable().optional(),
    passMark: z.number().nullable().optional(),
    questionCount: z.number().nullable().optional(),
    lastScore: z.number().nullable().optional(),
    lastPassed: z.boolean().nullable().optional(),
    identity: z.object({ required: z.string(), current: z.string().nullable(), met: z.boolean() }).nullable().optional(),
  }),
  questions: z
    .array(z.object({ id: z.string(), prompt: z.string(), options: z.array(z.object({ id: z.string(), text: z.string() })) }))
    .nullable(),
});
export type Eligibility = z.infer<typeof eligibilitySchema>;
export const assessmentSchema = z.object({ score: z.number(), passMark: z.number(), passed: z.boolean() });

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
  /** Market (IOC at the band edge) or limit (rests GTC at `price`). */
  type: 'market' | 'limit';
  price?: string;
  clientOpenId: string;
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
}

export function createFuturesApi(api: ApiClient) {
  return {
    markets: (signal?: AbortSignal) => api.rest('/markets', z.array(listingSchema), { query: { limit: 500 }, signal }),
    ticker: (symbol: string, signal?: AbortSignal) => api.rest('/futures/ticker', tickerStripSchema, { query: { symbol }, signal }),
    fundingRate: (symbol: string, signal?: AbortSignal) =>
      api.rest(`/funding-rate/${encodeURIComponent(symbol)}`, fundingRateSchema, { signal }),
    preview: (input: { symbol: string; side: 'long' | 'short'; size: string; leverage: string }, signal?: AbortSignal) =>
      api.rest('/positions/preview', positionPreviewSchema, { method: 'POST', body: { ...input, marginMode: 'isolated' }, signal }),
    /** Futures orders go through the book (futures ADR): an open is an order, a close is a reduce-only order. */
    placeOrder: (input: PlaceOrderInput) =>
      api.rest('/futures/orders', futuresOrderSchema, { method: 'POST', body: { ...input, marginMode: 'isolated' } }),
    cancelOrder: (orderId: string) => api.rest(`/futures/orders/${encodeURIComponent(orderId)}`, futuresOrderSchema, { method: 'DELETE' }),
    orders: (scope: 'open' | 'all', signal?: AbortSignal) =>
      api.rest('/futures/orders', z.array(futuresOrderSchema), { query: { scope, limit: 100 }, signal }),
    orderTypes: (signal?: AbortSignal) => api.rest('/futures/order-types', orderTypeCatalogueSchema, { query: { limit: 50 }, signal }),
    gatedList: (signal?: AbortSignal) => api.rest('/account/gated-list', gatedListSchema, { signal }),
    agreements: (signal?: AbortSignal) => api.rest('/account/agreements', agreementsSchema, { signal }),
    acceptAgreement: (input: { kind: string; version: number }) =>
      api.rest('/account/agreements/accept', z.object({ kind: z.string(), version: z.number() }), { method: 'POST', body: input }),
    eligibility: (signal?: AbortSignal) => api.rest('/account/derivatives-eligibility', eligibilitySchema, { signal }),
    assessEligibility: (input: { clientSubmissionId: string; answers: Record<string, string> }) =>
      api.rest('/account/derivatives-eligibility/assess', assessmentSchema, { method: 'POST', body: input }),
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
    marginCall: (positionId: string, signal?: AbortSignal) =>
      api.rest(`/positions/${encodeURIComponent(positionId)}/margin-call`, marginCallSchema, { signal }),
    adlDisclosure: (signal?: AbortSignal) => api.rest('/futures/adl-disclosure', adlDisclosureSchema, { signal }),
    adlAcknowledge: () => api.rest('/futures/adl-disclosure/ack', adlDisclosureSchema, { method: 'POST', body: {} }),
    adlEvents: (signal?: AbortSignal) => api.rest('/futures/adl-events', z.array(adlEventSchema), { query: { limit: 100 }, signal }),
  };
}
export type FuturesApi = ReturnType<typeof createFuturesApi>;
