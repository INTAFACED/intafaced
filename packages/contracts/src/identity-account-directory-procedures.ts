import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { HANDLES_CAP } from './identity-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-identity `accountDirectory.*`, one record per call: svc-identity mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-identity', module: 'identity', transport: 'trpc' } as const;

/** The handle of each account id a desk shows (an owner column): id and handle only, audited like a search. */
export const IDENTITY_ACCOUNT_DIRECTORY_HANDLES = defineProcedure({
  ...base,
  name: 'identity.accountDirectory.handles',
  kind: 'query',
  path: 'accountDirectory.handles',
  access: { caller: 'scope', scope: 'admin:compliance' },
  refusals: {},
  input: z.object({ ids: z.array(z.string().guid()).min(1).max(HANDLES_CAP) }).strict(),
  output: z.object({ rows: z.array(z.object({ id: z.string().guid(), handle: z.string() }).strict()) }).strict(),
  samples: [
    { verdict: 'accept', input: { ids: ['11111111-1111-4111-8111-111111111111'] } },
    { verdict: 'refuse', input: 42 },
  ],
});
