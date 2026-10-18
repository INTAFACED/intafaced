/**
 * Every call the Futures and Margin rooms make, in one place, through the existing client. Nothing else in these
 * rooms touches `api.rest`. Money fields are exact decimal strings; a price is never sent on open or close
 * (the service closes at its accepted mark and refuses a price field with `trade.price_not_accepted`).
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
  clientOpenId: string;
}

export function createFuturesApi(api: ApiClient) {
  return {
    markets: (signal?: AbortSignal) => api.rest('/markets', z.array(listingSchema), { query: { limit: 500 }, signal }),
    ticker: (symbol: string, signal?: AbortSignal) => api.rest('/futures/ticker', tickerStripSchema, { query: { symbol }, signal }),
    fundingRate: (symbol: string, signal?: AbortSignal) =>
      api.rest(`/funding-rate/${encodeURIComponent(symbol)}`, fundingRateSchema, { signal }),
    preview: (input: { symbol: string; side: 'long' | 'short'; size: string; leverage: string }, signal?: AbortSignal) =>
      api.rest('/positions/preview', positionPreviewSchema, { method: 'POST', body: { ...input, marginMode: 'isolated' }, signal }),
    open: (input: OpenInput) => api.rest('/positions', positionSchema, { method: 'POST', body: { ...input, marginMode: 'isolated' } }),
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
