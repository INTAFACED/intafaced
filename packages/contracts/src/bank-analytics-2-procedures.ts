import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { assetInput } from './bank-analytics-procedures.js';
import { assetIdSchema } from './asset-id.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-bank `analytics.*`, one record per call: svc-bank mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-bank', module: 'bank', transport: 'trpc' } as const;

/** Two to twelve months side by side by category, with each category's change; a month with no movement is zero. */
export const BANK_ANALYTICS_COMPARE = defineProcedure({
  ...base,
  name: 'bank.analytics.compare',
  kind: 'query',
  path: 'analytics.compare',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: assetInput.extend({
    months: z
      .array(z.string().regex(/^\d{4}-\d{2}$/))
      .min(2)
      .max(12),
  }),
  output: z.object({
    assetId: assetIdSchema,
    months: z.array(z.string()),
    categories: z.array(z.object({ category: z.string(), byMonth: z.array(z.string()), change: z.string() })),
    totalOutflow: z.array(z.string()),
    totalInflow: z.array(z.string()),
  }),
  // Written by hand: the wire replay's recorded sample (months ["x", "x"]) is refused by every caller, so the door names no
  // accepted input. Two different past months, each YYYY-MM, are what the door's compare takes (activity/analytics.rs).
  samples: [
    { verdict: 'accept', input: { assetId: 'USDC', months: ['2026-01', '2026-02'] } },
    { verdict: 'refuse', input: 42 },
    { verdict: 'refuse', input: { assetId: 'USDC', months: ['2026-01'] } },
  ],
});
