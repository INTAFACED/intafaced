import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { row } from './identity-list-passkeys-procedures.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-identity `.*`, one record per call: svc-identity mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-identity', module: 'identity', transport: 'trpc' } as const;

/**
 * Bind one passkey to the actions it answers for (I-signin-sessions-10): `signin`, `money_out`, `security_change`.
 * Sent sorted and comma-joined, the same string the step-up hashed; '' answers for every action.
 */
export const IDENTITY_SET_PASSKEY_PURPOSES = defineProcedure({
  ...base,
  name: 'identity.setPasskeyPurposes',
  kind: 'mutation',
  path: 'setPasskeyPurposes',
  access: { caller: 'scope', scope: 'identity:write' },
  refusals: {},
  input: z
    .object({
      credentialId: z.string().min(1).max(1024),
      purposes: z.string().max(64),
      clientRequestId: z.string().min(1).max(128),
      stepUpApprovalId: z.string().min(1).max(128).nullish(),
    })
    .strict(),
  output: row,
  samples: [
    { verdict: 'accept', input: { credentialId: 'placeholder', purposes: 'USDC', clientRequestId: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});
