import { z } from 'zod';
import { defineProcedure } from './procedure.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-identity `.*`, one record per call: svc-identity mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-identity', module: 'identity', transport: 'trpc' } as const;

export const IDENTITY_LIST_SESSIONS = defineProcedure({
  ...base,
  name: 'identity.listSessions',
  kind: 'query',
  path: 'listSessions',
  access: { caller: 'scope', scope: 'identity:read' },
  refusals: {},
  input: z.object({ userId: z.string().guid(), limit: z.number().int().min(1).max(200), cursor: z.string().max(200).optional() }),
  output: z.object({
    userId: z.string().guid(),
    sessions: z.array(
      z.object({
        id: z.string().guid(),
        familyId: z.string().guid(),
        createdAt: z.string(),
        lastUsedAt: z.string(),
        device: z.string().nullable(),
        userAgent: z.string().nullable(),
        ip: z.string().nullable(),
        country: z.string().nullable(),
        isCurrent: z.boolean(),
        revoked: z.literal(false),
      }),
    ),
    nextCursor: z.string().nullable(),
  }),
  samples: [
    { verdict: 'accept', input: { userId: '11111111-1111-4111-8111-111111111111', limit: 1 } },
    { verdict: 'refuse', input: 42 },
  ],
});
