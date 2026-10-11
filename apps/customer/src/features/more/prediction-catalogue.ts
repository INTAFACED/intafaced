import { z } from 'zod';

/** Published outcome metadata only. A listing confers no order or settlement
 * authority; the mounted producer currently returns an empty catalogue. */
export const predictionCatalogueSchema = z
  .array(
    z.object({
      id: z.string().min(1),
      kind: z.literal('outcome'),
      question: z.string().min(1),
      closeAt: z.string().datetime({ offset: true }),
      settlementAssetId: z.string().min(1),
      settlementSource: z.string().min(1),
      collateralization: z.literal('full'),
      instruments: z.array(z.object({ outcome: z.enum(['yes', 'no']), symbol: z.string().min(1) })).length(2),
    }),
  )
  .superRefine((rows, ctx) => {
    const ids = new Set<string>();
    const symbols = new Set<string>();
    for (const row of rows) {
      if (ids.has(row.id) || new Set(row.instruments.map((i) => i.outcome)).size !== 2)
        ctx.addIssue({ code: 'custom', message: 'Outcome identity or Yes/No pairing is ambiguous' });
      ids.add(row.id);
      for (const instrument of row.instruments) {
        if (symbols.has(instrument.symbol)) ctx.addIssue({ code: 'custom', message: 'Outcome instrument identity is ambiguous' });
        symbols.add(instrument.symbol);
      }
    }
  });
export type PublishedOutcome = z.infer<typeof predictionCatalogueSchema>[number];
