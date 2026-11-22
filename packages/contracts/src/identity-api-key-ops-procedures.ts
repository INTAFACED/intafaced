import { z } from 'zod';
import { defineProcedure } from './procedure.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-identity `apiKeyOps.*`, one record per call: svc-identity mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-identity', module: 'identity', transport: 'trpc' } as const;

export const IDENTITY_API_KEY_OPS_REVOKE = defineProcedure({
  ...base,
  name: 'identity.apiKeyOps.revoke',
  kind: 'mutation',
  path: 'apiKeyOps.revoke',
  access: { caller: 'scope', scope: 'admin:write' },
  refusals: {},
  input: z
    .object({
      userId: z.string().guid(),
      keyId: z.string().guid(),
      reason: z.string().max(500),
      clientRequestId: z.string().max(128),
    })
    .strict(),
  output: z
    .object({
      userId: z.string().guid(),
      keyId: z.string().guid(),
      changed: z.boolean(),
      revocation: z
        .object({ actorId: z.string().guid(), reason: z.string(), revokedAt: z.string().datetime({ offset: true }) })
        .strict()
        .nullable(),
    })
    .strict(),
  samples: [
    {
      verdict: 'accept',
      input: {
        userId: '11111111-1111-4111-8111-111111111111',
        keyId: '11111111-1111-4111-8111-111111111111',
        reason: 'USDC',
        clientRequestId: 'USDC',
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});
