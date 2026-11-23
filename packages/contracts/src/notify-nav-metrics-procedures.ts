import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { NAV_METRIC_DAYS_MAX } from './notify-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-notify `navMetrics.*`, one record per call: svc-notify mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-notify', module: 'notify', transport: 'trpc' } as const;

export const NOTIFY_NAV_METRICS_SEARCH_MISSES = defineProcedure({
  ...base,
  name: 'notify.navMetrics.searchMisses',
  kind: 'query',
  path: 'navMetrics.searchMisses',
  access: { caller: 'scope', scope: 'admin:read', module: 'notify' },
  refusals: {},
  input: z.object({ days: z.number().int().min(1).max(NAV_METRIC_DAYS_MAX).optional() }).optional(),
  output: z.object({
    kind: z.literal('search_miss'),
    from: z.string(),
    to: z.string(),
    days: z.array(z.object({ day: z.string(), count: z.number().int().nonnegative() })),
    /** Sent once with no retry (a lost count stays lost) to a public write anyone can call: neither floor nor ceiling. */
    approximate: z.literal(true),
  }),
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

export const NOTIFY_NAV_METRICS_SEARCH_MISS = defineProcedure({
  ...base,
  name: 'notify.navMetrics.searchMiss',
  kind: 'mutation',
  path: 'navMetrics.searchMiss',
  access: { caller: 'public' },
  refusals: {},
  input: z.object({ kind: z.literal('search_miss') }).strict(),
  output: z.object({ counted: z.literal(true) }),
  samples: [
    { verdict: 'accept', input: { kind: 'search_miss' } },
    { verdict: 'refuse', input: 42 },
  ],
});
