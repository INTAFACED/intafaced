import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { freezeLinkRedeemSchema } from './identity.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-identity `freezeLink.*`, one record per call: svc-identity mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-identity', module: 'identity', transport: 'trpc' } as const;

export const IDENTITY_FREEZE_LINK_REDEEM = defineProcedure({
  ...base,
  name: 'identity.freezeLink.redeem',
  kind: 'mutation',
  path: 'freezeLink.redeem',
  access: { caller: 'public' },
  refusals: {},
  input: z.object({ token: z.string().max(200) }).strict(),
  output: freezeLinkRedeemSchema,
  samples: [
    { verdict: 'accept', input: { token: 'placeholder' } },
    { verdict: 'refuse', input: 42 },
  ],
});
