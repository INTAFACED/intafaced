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
import {
  otcMakersAnswer,
  otcAcceptAnswer,
  otcSettleAnswer,
  otcConvertBoundsAnswer,
  otcQuoteFields,
  firmRfqFields,
  firmRfqAnswer,
  otcConvertQuoteAnswer,
} from '@intafaced/contracts/trade-call-schemas';

type Answer<F extends (...args: never[]) => unknown> = Awaited<ReturnType<F>>;

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

answerKeys<ReturnType<typeof listOtcMakers>>()(otcMakersAnswer);

answerKeys<Answer<OtcDeskService['accept']>>()(otcAcceptAnswer);

answerKeys<Answer<OtcDeskService['settle']>>()(otcSettleAnswer);

answerKeys<ReturnType<OtcDeskService['convertBoundsStatus']>>()(otcConvertBoundsAnswer);

answerKeys<Answer<OtcDeskService['convertQuote']>>()(otcConvertQuoteAnswer);

answerKeys<Answer<OtcDeskService['rfqGet']>>()(firmRfqAnswer);
answerKeys<Answer<OtcDeskService['rfqAccept']>>()(firmRfqAnswer);
answerKeys<Answer<OtcDeskService['rfqExpire']>>()(firmRfqAnswer);

export const rfqQuoteAnswer = z.object({
  ...firmRfqFields,
  quotes: z.array(z.object({ ...otcQuoteFields, rank: z.number() })),
});
answerKeys<Answer<OtcDeskService['rfqQuote']>>()(rfqQuoteAnswer);
