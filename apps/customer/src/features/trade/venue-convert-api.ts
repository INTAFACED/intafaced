// hand-declared-ok: svc-trade's venue Convert routes (/api/v1/venue/convert/*) have no browser-safe zod schema in packages/contracts; these follow services/svc-trade/src/venue/venue-convert.ts presentPairs, presentConvertQuote and presentConversion field for field
import { z } from 'zod';
import type { ApiClient } from '../../shared/api';
import { decimalSchema } from '../../shared/money';
import { preparedAnswerSchema, submitAnswerSchema, type KeptSignature } from './venue-api';

/**
 * Convert on the person's own venue account (J-cex-spot-11). A quote holds nothing and locks nothing; accepting it
 * prepares its one venue order for the wallet to sign under `convert:<owner>:<quoteId>`, and `submit` sends it once. A
 * conversion's paid and received amounts are read from the venue's own fills.
 */
const isoTime = z.string().datetime({ offset: true });
const assetAmount = z.object({ asset: z.string(), amount: decimalSchema });

const convertPairsSchema = z.object({
  venueId: z.string(),
  test: z.boolean(),
  paused: z.boolean(),
  assets: z.array(z.string()),
  restricted: z.array(z.string()),
  pairs: z.array(
    z.object({
      symbol: z.string(),
      base: z.string(),
      quote: z.string(),
      maxPerConvert: assetAmount.nullable(),
      minOrderNotional: decimalSchema.nullable(),
      lotSize: decimalSchema,
      tickSize: decimalSchema,
    }),
  ),
});
export type ConvertPairs = z.infer<typeof convertPairsSchema>;
export type ConvertPair = ConvertPairs['pairs'][number];

/** The partner's figure for a cash leg: `cash` of `currency` in, its fee inside it, `stableAmount` of `stable` delivered. */
const cashPriceSchema = z.object({
  currency: z.string(),
  cash: decimalSchema,
  fee: decimalSchema,
  rate: decimalSchema,
  stable: z.string(),
  stableAmount: decimalSchema,
});

const convertQuoteSchema = z.object({
  quoteId: z.string(),
  venueId: z.string(),
  test: z.boolean(),
  owner: z.string(),
  market: z.string(),
  side: z.enum(['buy', 'sell']),
  from: z.string(),
  to: z.string(),
  spend: decimalSchema,
  size: decimalSchema,
  maxCost: decimalSchema,
  bestPrice: z.object({ price: decimalSchema, asOf: isoTime }),
  limitPrice: decimalSchema,
  slippageBps: z.number().int(),
  builderFee: z.union([
    z.object({ kind: z.literal('none'), reason: z.literal('buy') }),
    z.object({
      kind: z.literal('quote_asset'),
      bps: decimalSchema,
      amount: z.union([z.object({ known: z.literal(true), value: decimalSchema }), z.object({ known: z.literal(false) })]),
    }),
  ]),
  venueFee: z.union([
    z.object({ known: z.literal(true), asset: z.string(), amount: decimalSchema }),
    z.object({ known: z.literal(false) }),
  ]),
  fill: z.union([
    z.object({ known: z.literal(true), amount: decimalSchema, averagePrice: decimalSchema.nullable() }),
    z.object({ known: z.literal(false) }),
  ]),
  held: z.literal(false),
  freshUntil: isoTime,
  createdAt: isoTime,
  cash: cashPriceSchema.nullable(),
});
export type ConvertQuote = z.infer<typeof convertQuoteSchema>;

const conversionSchema = z.object({
  actionKey: z.string(),
  kind: z.enum(['instant', 'limit']),
  quoteId: z.string().nullable(),
  market: z.string(),
  side: z.enum(['buy', 'sell']),
  from: z.string(),
  to: z.string(),
  venueClientOrderId: z.string().nullable(),
  limitPrice: decimalSchema,
  state: z.enum(['filled', 'partially_filled', 'resting', 'not_filled', 'rejected', 'unknown']),
  paid: assetAmount,
  received: assetAmount,
  venueFee: assetAmount.nullable(),
  builderFee: assetAmount.nullable(),
  fills: z.number().int(),
  filledAt: isoTime.nullable(),
  acceptedAt: isoTime,
  /** From a cash currency: the linked cash leg as the partner records it; the fields above are the venue leg's. */
  cashLeg: cashPriceSchema
    .extend({
      key: z.string(),
      legId: z.string().nullable(),
      state: z.enum(['pending', 'settled', 'refused', 'unknown']),
      settledAt: isoTime.nullable(),
    })
    .nullable(),
});
export type Conversion = z.infer<typeof conversionSchema>;

/** One venue market, or from a cash currency the partner's cash leg into `stable` and then a buy on `symbol`. */
const convertRouteSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('direct'), symbol: z.string(), side: z.enum(['buy', 'sell']) }),
  z.object({ kind: z.literal('cash'), symbol: z.string(), side: z.literal('buy'), currency: z.string(), stable: z.string() }),
]);
export type ConvertRoute = z.infer<typeof convertRouteSchema>;

export function venueConvertApi(api: ApiClient) {
  const post = <T>(path: string, schema: z.ZodType<T>, body: unknown) =>
    api.rest(`/venue/convert${path}`, schema, { method: 'POST', body });
  return {
    pairs: (signal?: AbortSignal) => api.rest('/venue/convert/pairs', convertPairsSchema, { signal }),
    route: (from: string, to: string, signal?: AbortSignal) =>
      api.rest('/venue/convert/route', convertRouteSchema, { query: { from, to }, signal }),
    quote: (body: { owner: string; from: string; to: string; amount: string; quoteKey: string }) =>
      post('/quote', convertQuoteSchema, body),
    accept: (body: { owner: string; quoteId: string }) => post('/accept', preparedAnswerSchema, body),
    limit: (body: { owner: string; from: string; to: string; amount: string; price: string; limitKey: string }) =>
      post('/limit', preparedAnswerSchema, body),
    submit: (actionKey: string, signature: KeptSignature) => post('/submit', submitAnswerSchema, { actionKey, signature }),
    history: (owner: string, signal?: AbortSignal) =>
      api.rest('/venue/convert/history', z.object({ conversions: z.array(conversionSchema), asOf: isoTime.nullable() }), {
        query: { owner },
        signal,
      }),
  };
}
export type VenueConvertApi = ReturnType<typeof venueConvertApi>;
