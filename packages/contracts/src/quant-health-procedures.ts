import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-quant `health.*`, one record per call: svc-quant mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-quant', module: 'quant', transport: 'trpc' } as const;

export const QUANT_HEALTH = defineProcedure({
  ...base,
  name: 'quant.health',
  kind: 'query',
  path: 'health',
  access: { caller: 'public' },
  refusals: {},
  input: NO_INPUT,
  output: z.object({ ok: z.literal(true), service: z.literal('svc-quant') }),
  samples: [{ verdict: 'accept' }],
});
