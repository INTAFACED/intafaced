import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { quantAccountField as accountField } from './quant-wire.js';
import { quantQuotaSchema } from './quant-algo.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-quant `quota.*`, one record per call: svc-quant mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-quant', module: 'quant', transport: 'trpc' } as const;

/**
 * The caller's plan (AL-limits-01): the profile that applies, and each resource's usage, counted from the stored
 * rows, against its limit. A blank limit reads null and the screen says "not set"; with no profile, every limit does.
 */
export const QUANT_QUOTA_GET = defineProcedure({
  ...base,
  name: 'quant.quota.get',
  kind: 'query',
  path: 'quota.get',
  access: { caller: 'jurisdiction', module: 'quant', plane: 'fiat' },
  refusals: {},
  input: z.object({ ...accountField }).optional(),
  output: quantQuotaSchema,
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});
