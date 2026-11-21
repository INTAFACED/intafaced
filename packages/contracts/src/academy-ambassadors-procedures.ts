import { z } from 'zod';
import { defineProcedure } from './procedure.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-academy `ambassadors.*`, one record per call: svc-academy mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-academy', module: 'academy', transport: 'trpc' } as const;

export const ambassadorStatus = z.enum(['active', 'frozen']);

export const ambassadorOut = z.object({
  userId: z.string().guid(),
  status: ambassadorStatus,
  appointedBy: z.string().guid(),
  appointedAt: z.iso.datetime({ offset: true }),
  frozenAt: z.iso.datetime({ offset: true }).nullable(),
  frozenBy: z.string().guid().nullable(),
  freezeReason: z.string().nullable(),
});

export const ACADEMY_AMBASSADORS = defineProcedure({
  ...base,
  name: 'academy.ambassadors',
  kind: 'query',
  path: 'ambassadors',
  access: { caller: 'scope', scope: 'admin:read', module: 'academy' },
  refusals: { 'academy.ambassadors_list_limit_unset': 'PRECONDITION_FAILED' },
  input: z.object({ status: ambassadorStatus.optional(), limit: z.number().optional() }).optional(),
  output: z.array(ambassadorOut),
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});
