import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { analyticsSummarySchema } from './agents-review.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-agents `analytics.*`, one record per call, written from its router while its Rust port is in flight: every app caller calls it by its record, and the router keeps its own schemas until the port's switch. */

const base = { service: 'svc-agents', module: 'agents', transport: 'trpc' } as const;

/**
 * The person's dashboard over a range of UTC days, both ends included. A blank end refuses naming it
 * (`agents.analytics_range_unset`); test and dry runs are counted only when `includeTest` is true.
 */
export const AGENTS_ANALYTICS_SUMMARY = defineProcedure({
  ...base,
  name: 'agents.analytics.summary',
  kind: 'query',
  path: 'analytics.summary',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents' },
  refusals: {},
  input: z
    .object({
      from: z.string().max(32).optional(),
      to: z.string().max(32).optional(),
      includeTest: z.boolean().optional(),
    })
    .strict(),
  output: analyticsSummarySchema,
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});
