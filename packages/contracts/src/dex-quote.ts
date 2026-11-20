import { z } from 'zod';

/** svc-dex's `quote` answer (services/svc-dex/src/router-quote.ts), keeping only the fields the Protocol room renders. Browser-safe (zod only). */
export const dexQuoteSchema = z.object({
  symbol: z.string(),
  side: z.enum(['buy', 'sell']),
  route: z.object({
    kind: z.enum(['quote', 'preview']),
    executable: z.boolean(),
    legs: z.array(z.object({ venue: z.string(), kind: z.string(), qty: z.string(), quoteAmount: z.string(), effectivePrice: z.string() })),
    filledQty: z.string(),
    unfilledQty: z.string(),
    totalQuoteAmount: z.string(),
  }),
  venues: z.array(z.object({ venueId: z.string(), plane: z.string(), custodial: z.boolean(), feeBps: z.number(), ageMs: z.number() })),
  unavailable: z.array(z.object({ venueId: z.string(), reason: z.string(), detail: z.string() })),
  degraded: z.boolean(),
  singleVenue: z.boolean(),
  executable: z.boolean(),
  nonExecutableReason: z.string().nullable(),
  asOf: z.string(),
});
