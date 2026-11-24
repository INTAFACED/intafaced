import { z } from 'zod';
import { defineProcedure } from './procedure.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-identity `.*`, one record per call: svc-identity mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-identity', module: 'identity', transport: 'trpc' } as const;

export const IDENTITY_REVOKE_SESSION = defineProcedure({
  ...base,
  name: 'identity.revokeSession',
  kind: 'mutation',
  path: 'revokeSession',
  access: { caller: 'scope', scope: 'identity:write' },
  refusals: {},
  input: z.object({ userId: z.string().guid(), sessionId: z.string().guid() }),
  output: z.object({
    userId: z.string().guid(),
    sessionId: z.string().guid(),
    revoked: z.boolean(),
  }),
  samples: [
    { verdict: 'accept', input: { userId: '11111111-1111-4111-8111-111111111111', sessionId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});
