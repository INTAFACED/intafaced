import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { clientRequestId, methodsOutput, stepUpApprovalId } from './identity-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-identity `unlinkSigninMethod.*`, one record per call: svc-identity mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-identity', module: 'identity', transport: 'trpc' } as const;

export const IDENTITY_UNLINK_SIGNIN_METHOD = defineProcedure({
  ...base,
  name: 'identity.unlinkSigninMethod',
  kind: 'mutation',
  path: 'unlinkSigninMethod',
  access: { caller: 'scope', scope: 'identity:write' },
  refusals: {},
  input: z.object({ method: z.string().min(1).max(64), clientRequestId, stepUpApprovalId }).strict(),
  output: methodsOutput,
  samples: [
    { verdict: 'accept', input: { method: 'USDC', clientRequestId: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});
