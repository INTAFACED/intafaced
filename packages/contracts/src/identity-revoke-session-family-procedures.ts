import { z } from 'zod';
import { defineProcedure } from './procedure.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-identity `revokeSessionFamily.*`, one record per call: svc-identity mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-identity', module: 'identity', transport: 'trpc' } as const;

/** Ends one sign-in by its family id. Another account's family answers like one that does not exist. */
export const IDENTITY_REVOKE_SESSION_FAMILY = defineProcedure({
  ...base,
  name: 'identity.revokeSessionFamily',
  kind: 'mutation',
  path: 'revokeSessionFamily',
  access: { caller: 'scope', scope: 'identity:write' },
  refusals: {},
  input: z.object({ familyId: z.string().guid() }).strict(),
  output: z.object({ familyId: z.string().guid(), revoked: z.boolean() }).strict(),
  samples: [
    { verdict: 'accept', input: { familyId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});
