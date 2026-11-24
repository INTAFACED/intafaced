import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { quantAccountField as accountField } from './quant-wire.js';
import { quantQuickStartOutputSchema } from './quant-algo.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-quant `quickStart.*`, one record per call: svc-quant mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-quant', module: 'quant', transport: 'trpc' } as const;

export const QUANT_QUICK_START = defineProcedure({
  ...base,
  name: 'quant.quickStart',
  kind: 'query',
  path: 'quickStart',
  access: { caller: 'jurisdiction', module: 'quant', plane: 'fiat' },
  refusals: {},
  input: z.object({ ...accountField }).optional(),
  output: quantQuickStartOutputSchema,
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});
