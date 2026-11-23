import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { opsVenueEconomicsSchema } from './ops-venue-economics.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-ops `venueEconomics.*`, one record per call: svc-ops mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-ops', module: 'ops', transport: 'trpc' } as const;

export const OPS_VENUE_ECONOMICS = defineProcedure({
  ...base,
  name: 'ops.venueEconomics',
  kind: 'query',
  path: 'venueEconomics',
  access: { caller: 'scope', scope: 'admin:read', module: 'core-ops', plane: 'fiat' },
  refusals: { 'ops.cost_period_invalid': 'PRECONDITION_FAILED', 'ops.cost_storage_unconfigured': 'PRECONDITION_FAILED' },
  input: z.object({ period: z.string() }),
  output: opsVenueEconomicsSchema,
  samples: [
    { verdict: 'accept', input: { period: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});
