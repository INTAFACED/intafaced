import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { clientRequestId, methodsOutput, phone, stepUpApprovalId, walletAnswer } from './identity-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-identity `linkSigninMethod.*`, one record per call: svc-identity mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-identity', module: 'identity', transport: 'trpc' } as const;

export const IDENTITY_LINK_SIGNIN_METHOD = defineProcedure({
  ...base,
  name: 'identity.linkSigninMethod',
  kind: 'mutation',
  path: 'linkSigninMethod',
  access: { caller: 'scope', scope: 'identity:write' },
  refusals: {},
  input: z
    .object({
      method: z.string().min(1).max(64),
      clientRequestId,
      stepUpApprovalId,
      password: z.string().max(1024).optional(),
      phone: phone.optional(),
      /** The six-digit code texted to `phone`. Without it, a phone link texts one. */
      code: z.string().max(16).optional(),
      wallet: walletAnswer.optional(),
    })
    .strict(),
  output: methodsOutput,
  samples: [
    { verdict: 'accept', input: { method: 'USDC', clientRequestId: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});
