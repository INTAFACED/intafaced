import type { z } from 'zod';
import {
  venueConvertAcceptSchema,
  venueConversionSchema,
  venueConvertHistorySchema,
  venueConvertPairsSchema,
  venueConvertQuoteSchema,
  venueConvertRouteSchema,
} from '@intafaced/contracts/trade-venue-door';
import type { ApiClient } from '../../shared/api';
import { preparedAnswerSchema, submitAnswerSchema, type KeptSignature } from './venue-api';

/**
 * Convert on the person's own venue account (J-cex-spot-11). A quote holds nothing and locks nothing; accepting it
 * prepares its one venue order for the wallet to sign under `convert:<owner>:<quoteId>`, and `submit` sends it once. A
 * conversion's paid and received amounts are read from the venue's own fills.
 */
export type ConvertPairs = z.infer<typeof venueConvertPairsSchema>;
export type ConvertPair = ConvertPairs['pairs'][number];
export type ConvertQuote = z.infer<typeof venueConvertQuoteSchema>;
export type Conversion = z.infer<typeof venueConversionSchema>;
export type CashOffer = ConvertPairs['cash'][number];

export function venueConvertApi(api: ApiClient) {
  const post = <T>(path: string, schema: z.ZodType<T>, body: unknown) =>
    api.rest(`/venue/convert${path}`, schema, { method: 'POST', body });
  return {
    pairs: (signal?: AbortSignal) => api.rest('/venue/convert/pairs', venueConvertPairsSchema, { signal }),
    route: (from: string, to: string, signal?: AbortSignal) =>
      api.rest('/venue/convert/route', venueConvertRouteSchema, {
        query: { from, to },
        signal,
      }),
    quote: (body: { owner: string; from: string; to: string; amount: string; quoteKey: string }) =>
      post('/quote', venueConvertQuoteSchema, body),
    accept: (body: { owner: string; quoteId: string }) => post('/accept', venueConvertAcceptSchema, body),
    limit: (body: { owner: string; from: string; to: string; amount: string; price: string; limitKey: string }) =>
      post('/limit', preparedAnswerSchema, body),
    submit: (actionKey: string, signature: KeptSignature) => post('/submit', submitAnswerSchema, { actionKey, signature }),
    history: (owner: string, signal?: AbortSignal) =>
      api.rest('/venue/convert/history', venueConvertHistorySchema, {
        query: { owner },
        signal,
      }),
  };
}
export type VenueConvertApi = ReturnType<typeof venueConvertApi>;
