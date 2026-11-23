import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { quantAccountField as accountField } from './quant-wire.js';
import { quantTierListSchema } from './quant-algo.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-quant `tier.*`, one record per call: svc-quant mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-quant', module: 'quant', transport: 'trpc' } as const;

/**
 * The published compute tiers (RC-algo-dev-05): each tier's data freshness, priority class and the limits of its
 * profile, blank values null ("not set"), and the profile that applies to the caller. None published: an empty list.
 */
export const QUANT_TIER_LIST = defineProcedure({
  ...base,
  name: 'quant.tier.list',
  kind: 'query',
  path: 'tier.list',
  access: { caller: 'jurisdiction', module: 'quant', plane: 'fiat' },
  refusals: {},
  input: z.object({ ...accountField }).optional(),
  output: quantTierListSchema,
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});
