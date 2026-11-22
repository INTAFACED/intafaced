import { z } from 'zod';
import { defineProcedure } from './procedure.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-identity `revokeOtherSessions.*`, one record per call: svc-identity mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-identity', module: 'identity', transport: 'trpc' } as const;

/** Ends every sign-in except the one making the call. Idempotent: a second call ends nothing. */
export const IDENTITY_REVOKE_OTHER_SESSIONS = defineProcedure({
  ...base,
  name: 'identity.revokeOtherSessions',
  kind: 'mutation',
  path: 'revokeOtherSessions',
  access: { caller: 'scope', scope: 'identity:write' },
  refusals: {},
  input: z.object({}).strict(),
  output: z.object({ revokedFamilies: z.number().int() }).strict(),
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});
