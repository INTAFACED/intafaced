import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { previewActInputSchema } from './quant-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-quant `preview.*`, one record per call: svc-quant mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-quant', module: 'quant', transport: 'trpc' } as const;

export const QUANT_PREVIEW_ACT = defineProcedure({
  ...base,
  name: 'quant.preview.act',
  kind: 'mutation',
  path: 'preview.act',
  access: { caller: 'signedIn' },
  refusals: {},
  input: previewActInputSchema,
  output: z.never(),
  samples: [
    { verdict: 'accept', input: { room: 'editor', action: 'compile' } },
    { verdict: 'refuse', input: 42 },
  ],
});
