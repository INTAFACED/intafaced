/**
 * The answer schemas of `trade.otc.*` and `trade.rfq.*` (quote, accept, expire, get): each names every key its handler
 * answers with (`answerKeys`) and checks no more than the handler's own type, so a reply leaves exactly as it did before
 * the schema was added. zod writes an object's keys in its schema's order, so each schema lists them in the order its
 * handler builds them.
 */
import { answerKeys } from '../answer-keys.js';
import type { listOtcMakers } from './maker-directory.js';
import type { OtcDeskService } from './otc-service.js';
import {
  otcMakersAnswer,
  otcAcceptAnswer,
  otcSettleAnswer,
  otcConvertBoundsAnswer,
  firmRfqAnswer,
  otcConvertQuoteAnswer,
  otcDeskStatusAnswer,
  rfqQuoteAnswer,
} from '@intafaced/contracts/trade-call-schemas';

type Answer<F extends (...args: never[]) => unknown> = Awaited<ReturnType<F>>;

answerKeys<ReturnType<OtcDeskService['deskStatus']>>()(otcDeskStatusAnswer);

answerKeys<ReturnType<typeof listOtcMakers>>()(otcMakersAnswer);

answerKeys<Answer<OtcDeskService['accept']>>()(otcAcceptAnswer);

answerKeys<Answer<OtcDeskService['settle']>>()(otcSettleAnswer);

answerKeys<ReturnType<OtcDeskService['convertBoundsStatus']>>()(otcConvertBoundsAnswer);

answerKeys<Answer<OtcDeskService['convertQuote']>>()(otcConvertQuoteAnswer);

answerKeys<Answer<OtcDeskService['rfqGet']>>()(firmRfqAnswer);
answerKeys<Answer<OtcDeskService['rfqAccept']>>()(firmRfqAnswer);
answerKeys<Answer<OtcDeskService['rfqExpire']>>()(firmRfqAnswer);

answerKeys<Answer<OtcDeskService['rfqQuote']>>()(rfqQuoteAnswer);
