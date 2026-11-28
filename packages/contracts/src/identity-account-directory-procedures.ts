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

export const directoryRow = z
  .object({
    id: z.string().guid(),
    handle: z.string(),
    status: z.enum(['active', 'frozen', 'closed']),
    created: z.string().datetime({ offset: true }),
    kycTier: z.enum(['none', 'basic', 'full', 'institutional']),
    restrictedAreas: z.array(z.enum(['identity', 'trading'])),
    emailMasked: z.string(),
  })
  .strict();

export const IDENTITY_ACCOUNT_DIRECTORY_SEARCH = defineProcedure({
  ...base,
  name: 'identity.accountDirectory.search',
  kind: 'query',
  path: 'accountDirectory.search',
  access: { caller: 'scope', scope: 'admin:compliance' },
  refusals: {},
  input: z
    .object({
      email: z.string().max(320).optional(),
      handle: z.string().max(32).optional(),
      cursor: z.string().max(512).optional(),
    })
    .strict(),
  output: z.object({ rows: z.array(directoryRow), nextCursor: z.string().nullable() }).strict(),
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});
