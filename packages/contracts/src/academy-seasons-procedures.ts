import { z } from 'zod';
import { defineProcedure } from './procedure.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-academy `seasons.*`, one record per call: svc-academy mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-academy', module: 'academy', transport: 'trpc' } as const;

export const seasonStatus = z.enum(['scheduled', 'live', 'frozen', 'ended']);

export const seasonOut = z.object({
  id: z.string().guid(),
  slug: z.string(),
  title: z.string(),
  status: seasonStatus,
  rulesSummary: z.string(),
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }).nullable(),
});

export const ACADEMY_SEASONS = defineProcedure({
  ...base,
  name: 'academy.seasons',
  kind: 'query',
  path: 'seasons',
  access: { caller: 'scope', scope: 'academy:read', module: 'academy' },
  refusals: { 'academy.seasons_list_limit_unset': 'PRECONDITION_FAILED', 'academy.tournament_disabled': 'FORBIDDEN' },
  input: z.object({ status: seasonStatus.optional(), limit: z.number().optional() }).optional(),
  output: z.array(seasonOut),
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});
