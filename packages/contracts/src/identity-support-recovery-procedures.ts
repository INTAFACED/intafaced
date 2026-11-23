import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { supportRecoveryRedeemSchema } from './identity.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-identity `supportRecovery.*`, one record per call: svc-identity mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-identity', module: 'identity', transport: 'trpc' } as const;

export const IDENTITY_SUPPORT_RECOVERY_REDEEM = defineProcedure({
  ...base,
  name: 'identity.supportRecovery.redeem',
  kind: 'mutation',
  path: 'supportRecovery.redeem',
  access: { caller: 'public' },
  refusals: {},
  input: z.object({ token: z.string().min(1).max(128) }).strict(),
  output: supportRecoveryRedeemSchema,
  samples: [
    { verdict: 'accept', input: { token: 'placeholder' } },
    { verdict: 'refuse', input: 42 },
  ],
});
