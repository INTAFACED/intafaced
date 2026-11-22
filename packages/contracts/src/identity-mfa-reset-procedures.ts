import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';
import { mfaResetCancelSchema, mfaResetStatusSchema } from './identity.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-identity `mfaReset.*`, one record per call: svc-identity mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-identity', module: 'identity', transport: 'trpc' } as const;

export const IDENTITY_MFA_RESET_STATUS = defineProcedure({
  ...base,
  name: 'identity.mfaReset.status',
  kind: 'query',
  path: 'mfaReset.status',
  access: { caller: 'scope', scope: 'identity:read' },
  refusals: {},
  input: NO_INPUT,
  output: mfaResetStatusSchema,
  samples: [{ verdict: 'accept' }],
});

export const IDENTITY_MFA_RESET_CANCEL = defineProcedure({
  ...base,
  name: 'identity.mfaReset.cancel',
  kind: 'mutation',
  path: 'mfaReset.cancel',
  access: { caller: 'scope', scope: 'identity:write' },
  refusals: {},
  input: z.object({}).strict().optional(),
  output: mfaResetCancelSchema,
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});
