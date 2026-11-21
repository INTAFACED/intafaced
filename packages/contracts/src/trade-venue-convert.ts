/**
 * svc-trade's venue Convert routes (`/api/v1/venue/convert/*`, J-cex-spot-11) as the customer app reads them. Browser-safe
 * (zod only). A quote holds nothing and locks nothing; a conversion's paid and received amounts are the venue's own fills;
 * from a cash currency the partner's cash leg is linked to the venue leg. svc-trade's `presentPairs`,
 * `presentConvertQuote` and `presentConversion` (services/svc-trade/src/venue/venue-convert.ts) return these types.
 */
import { z } from 'zod';
import { isoTime } from './trade-venue-door.js';
import { unsignedAmountSchema as decimalSchema } from './wire-amount.js';

const assetAmount = z.object({ asset: z.string(), amount: decimalSchema });

export const convertPairsSchema = z.object({
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
export const cashPriceSchema = z.object({
  currency: z.string(),
  cash: decimalSchema,
  fee: decimalSchema,
  rate: decimalSchema,
  stable: z.string(),
  stableAmount: decimalSchema,
});

export const convertQuoteSchema = z.object({
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

export const conversionSchema = z.object({
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
export const convertRouteSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('direct'), symbol: z.string(), side: z.enum(['buy', 'sell']) }),
  z.object({ kind: z.literal('cash'), symbol: z.string(), side: z.literal('buy'), currency: z.string(), stable: z.string() }),
]);
export type ConvertRoute = z.infer<typeof convertRouteSchema>;

/** `/venue/convert/history`: the person's conversions, newest first, as of the venue's last read. */
export const conversionHistorySchema = z.object({ conversions: z.array(conversionSchema), asOf: isoTime.nullable() });
