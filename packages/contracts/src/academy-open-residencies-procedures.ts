import { z } from 'zod';
import { defineProcedure } from './procedure.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-academy `openResidencies.*`, one record per call: svc-academy mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-academy', module: 'academy', transport: 'trpc' } as const;

export const residencyStatus = z.enum(['applied', 'accepted', 'rejected', 'withdrawn']);

export const residencyOut = z.object({
  id: z.string().guid(),
  userId: z.string().guid(),
  cohortSlug: z.string(),
  statement: z.string(),
  status: residencyStatus,
  appliedAt: z.iso.datetime({ offset: true }),
  decidedAt: z.iso.datetime({ offset: true }).nullable(),
  decidedBy: z.string().guid().nullable(),
  decisionNote: z.string().nullable(),
});

export const ACADEMY_OPEN_RESIDENCIES = defineProcedure({
  ...base,
  name: 'academy.openResidencies',
  kind: 'query',
  path: 'openResidencies',
  access: { caller: 'scope', scope: 'admin:read', module: 'academy' },
  refusals: { 'academy.open_residencies_list_limit_unset': 'PRECONDITION_FAILED' },
  input: z.object({ cohortSlug: z.string().min(3).max(48).optional(), limit: z.number().optional() }).optional(),
  output: z.array(residencyOut),
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});
