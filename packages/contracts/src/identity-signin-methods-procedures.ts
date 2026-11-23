import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { methodsOutput } from './identity-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-identity `signinMethods.*`, one record per call: svc-identity mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-identity', module: 'identity', transport: 'trpc' } as const;

export const IDENTITY_SIGNIN_METHODS = defineProcedure({
  ...base,
  name: 'identity.signinMethods',
  kind: 'query',
  path: 'signinMethods',
  access: { caller: 'scope', scope: 'identity:read' },
  refusals: {},
  input: z.object({}).strict().optional(),
  output: methodsOutput,
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});
