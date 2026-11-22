import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-token `nextEmissionEpoch.*`, one record per call: svc-token mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-token', module: 'token', transport: 'trpc' } as const;

export const TOKEN_NEXT_EMISSION_EPOCH = defineProcedure({
  ...base,
  name: 'token.nextEmissionEpoch',
  kind: 'query',
  path: 'nextEmissionEpoch',
  access: { caller: 'scope', scope: 'token:read' },
  refusals: {},
  input: NO_INPUT,
  output: z.object({ epoch: z.number().int().nonnegative() }),
  samples: [{ verdict: 'accept' }],
});
