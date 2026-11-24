import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { quantAccountField as accountField } from './quant-wire.js';
import { quantLimitsSchema } from './quant-algo.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-quant `limits.*`, one record per call: svc-quant mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-quant', module: 'quant', transport: 'trpc' } as const;

/**
 * Every limit the caller's runs meet (J-algo-dev-12 #4), as the sandbox will apply it: the applied plan's sandbox
 * limits (null: not set, and then no run starts) and the two ceilings every plan shares.
 */
export const QUANT_LIMITS_GET = defineProcedure({
  ...base,
  name: 'quant.limits.get',
  kind: 'query',
  path: 'limits.get',
  access: { caller: 'jurisdiction', module: 'quant', plane: 'fiat' },
  refusals: {},
  input: z.object({ ...accountField }).optional(),
  output: quantLimitsSchema,
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});
