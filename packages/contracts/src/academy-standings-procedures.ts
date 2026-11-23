import { z } from 'zod';
import { defineProcedure } from './procedure.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-academy `standings.*`, one record per call: svc-academy mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-academy', module: 'academy', transport: 'trpc' } as const;

export const standingOut = z.object({
  seasonId: z.string().guid(),
  userId: z.string().guid(),
  score: z.number().int(),
  updatedAt: z.iso.datetime({ offset: true }),
  rank: z.number().int(),
});

export const ACADEMY_STANDINGS = defineProcedure({
  ...base,
  name: 'academy.standings',
  kind: 'query',
  path: 'standings',
  access: { caller: 'scope', scope: 'academy:read', module: 'academy' },
  refusals: {
    'academy.season_not_found': 'NOT_FOUND',
    'academy.standings_limit_unset': 'PRECONDITION_FAILED',
    'academy.tournament_disabled': 'FORBIDDEN',
  },
  input: z.object({ seasonId: z.string().guid(), limit: z.number().optional() }),
  output: z.array(standingOut),
  samples: [
    { verdict: 'accept', input: { seasonId: '33333333-3333-4333-8333-333333333333' } },
    { verdict: 'refuse', input: 42 },
  ],
});
