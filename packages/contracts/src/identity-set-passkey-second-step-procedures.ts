import { z } from 'zod';
import { defineProcedure } from './procedure.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-identity `.*`, one record per call: svc-identity mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-identity', module: 'identity', transport: 'trpc' } as const;

/** Ask, or stop asking, for a passkey after the password at sign-in (I-signin-sessions-10). */
export const IDENTITY_SET_PASSKEY_SECOND_STEP = defineProcedure({
  ...base,
  name: 'identity.setPasskeySecondStep',
  kind: 'mutation',
  path: 'setPasskeySecondStep',
  access: { caller: 'scope', scope: 'identity:write' },
  refusals: {},
  input: z
    .object({
      on: z.boolean(),
      clientRequestId: z.string().min(1).max(128),
      stepUpApprovalId: z.string().min(1).max(128).nullish(),
    })
    .strict(),
  output: z.object({ secondStep: z.boolean() }),
  samples: [
    { verdict: 'accept', input: { on: true, clientRequestId: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});
