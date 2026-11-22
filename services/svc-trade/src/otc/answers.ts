/**
 * The answer schemas of `trade.otc.*` and `trade.rfq.*` (quote, accept, expire, get): each names every key its handler
 * answers with (`answerKeys`) and checks no more than the handler's own type, so a reply leaves exactly as it did before
 * the schema was added. zod writes an object's keys in its schema's order, so each schema lists them in the order its
 * handler builds them.
 */
import { z } from 'zod';
import { answerKeys } from '../answer-keys.js';
import type { listOtcMakers } from './maker-directory.js';
import type { OtcDeskService } from './otc-service.js';

type Answer<F extends (...args: never[]) => unknown> = Awaited<ReturnType<F>>;

const otcSide = z.enum(['buy', 'sell']);
const otcCounterparty = z.enum(['platform', 'maker']);
const midFeedSocket = z.literal('socket.otc-mid-feed');

/**
 * The desk's mid feed. The wired form is tried first: only it has `wiring`, so a plain status never reads as one, and a
 * wired status is never stripped of it. The two plain forms differ in their `published` literal.
 */
const otcMidFeedAnswer = z.union([
  z.object({
    wiring: z.enum(['flag_off', 'flag_on_venue_unwired', 'flag_on_symbol_map_empty', 'live_observation']),
    published: z.boolean(),
    socket: midFeedSocket,
    residual: z.string().nullable(),
    bootMapAllowed: z.boolean(),
    liveObservationFeed: z.boolean(),
  }),
  z.object({
    published: z.literal(true),
    socket: midFeedSocket,
    residual: z.null(),
    bootMapAllowed: z.literal(false),
    liveObservationFeed: z.literal(true),
  }),
  z.object({
    published: z.literal(false),
    socket: midFeedSocket,
    residual: z.string(),
    bootMapAllowed: z.literal(true),
    liveObservationFeed: z.literal(false),
  }),
]);

export const otcDeskStatusAnswer = z.object({
  published: z.boolean(),
  statusLine: z.string(),
  residual: z.string().nullable(),
  assets: z.array(z.string()).readonly().nullable(),
  minTier: z.enum(['basic', 'full', 'institutional']).nullable(),
  makerRouting: z.object({ published: z.literal(false), socket: z.literal('socket.otc-maker-routing'), residual: z.string() }),
  midFeed: otcMidFeedAnswer,
  residuals: z.object({
    deskLaw: z.string().nullable(),
    assets: z.string().nullable(),
    minTier: z.string().nullable(),
    makerRouting: z.string(),
    midFeed: z.string().nullable(),
  }),
});
answerKeys<ReturnType<OtcDeskService['deskStatus']>>()(otcDeskStatusAnswer);

const otcMaker = z.object({
  id: z.string(),
  name: z.string(),
  route: z.enum(['platform', 'outside']),
  spreadBps: z.number().optional(),
});
/** The two forms differ in their `published` literal, so neither can read as the other and the order is safe. */
export const otcMakersAnswer = z.union([
  z.object({ published: z.literal(false), makers: z.array(otcMaker), selectCap: z.null(), emptyLabel: z.string() }),
  z.object({ published: z.literal(true), makers: z.array(otcMaker), selectCap: z.number(), emptyLabel: z.null() }),
]);
answerKeys<ReturnType<typeof listOtcMakers>>()(otcMakersAnswer);

const boundOtcFillFields = {
  quoteId: z.string(),
  side: otcSide,
  baseAsset: z.string(),
  quoteAsset: z.string(),
  qty: z.string(),
  fillPrice: z.string(),
  fillNotional: z.string(),
  spreadBps: z.number(),
  counterparty: otcCounterparty,
  counterpartyId: z.string(),
  acceptedAt: z.string(),
};

export const otcAcceptAnswer = z.object(boundOtcFillFields);
answerKeys<Answer<OtcDeskService['accept']>>()(otcAcceptAnswer);

export const otcSettleAnswer = z.object({
  fillId: z.string(),
  takerOrderId: z.string(),
  makerOrderId: z.string(),
  ...boundOtcFillFields,
});
answerKeys<Answer<OtcDeskService['settle']>>()(otcSettleAnswer);

const convertFlowBounds = z.object({ minQty: z.string(), maxQty: z.string() }).nullable();
export const otcConvertBoundsAnswer = z.object({ convert: convertFlowBounds, oneClickBuy: convertFlowBounds });
answerKeys<ReturnType<OtcDeskService['convertBoundsStatus']>>()(otcConvertBoundsAnswer);

/** `presentOtcQuote` (rfq.ts). */
const otcQuoteFields = {
  quoteId: z.string(),
  side: otcSide,
  baseAsset: z.string(),
  quoteAsset: z.string(),
  qty: z.string(),
  midPrice: z.string(),
  quotedPrice: z.string(),
  midNotional: z.string(),
  userNotional: z.string(),
  spreadBps: z.number(),
  spreadNotional: z.string(),
  counterparty: otcCounterparty,
  counterpartyId: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
  status: z.literal('open'),
  rfqId: z.string(),
  rfqSeq: z.number(),
  makerId: z.string().nullable(),
  test: z.boolean(),
};

export const otcConvertQuoteAnswer = z.object({
  flow: z.enum(['convert', 'oneClickBuy']),
  ...otcQuoteFields,
  settleWindowMs: z.number().nullable(),
});
answerKeys<Answer<OtcDeskService['convertQuote']>>()(otcConvertQuoteAnswer);

/** `presentFirmRfq` (rfq.ts). */
const firmRfqFields = {
  ...otcQuoteFields,
  lifecycle: z.enum(['open', 'bound', 'expired', 'settled']),
  acceptedAt: z.string().nullable(),
  fillPrice: z.string().nullable(),
  settleBy: z.string().nullable(),
  settleWindowMs: z.number().nullable(),
  bookFill: z.literal(false),
  midInvented: z.literal(false),
};

export const firmRfqAnswer = z.object(firmRfqFields);
answerKeys<Answer<OtcDeskService['rfqGet']>>()(firmRfqAnswer);
answerKeys<Answer<OtcDeskService['rfqAccept']>>()(firmRfqAnswer);
answerKeys<Answer<OtcDeskService['rfqExpire']>>()(firmRfqAnswer);

export const rfqQuoteAnswer = z.object({
  ...firmRfqFields,
  quotes: z.array(z.object({ ...otcQuoteFields, rank: z.number() })),
});
answerKeys<Answer<OtcDeskService['rfqQuote']>>()(rfqQuoteAnswer);
