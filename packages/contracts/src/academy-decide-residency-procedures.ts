import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { operatorApprovalIds } from './academy-appoint-ambassador-procedures.js';
import { residencyOut } from './academy-open-residencies-procedures.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-academy `decideResidency.*`, one record per call: svc-academy mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-academy', module: 'academy', transport: 'trpc' } as const;

export const ACADEMY_DECIDE_RESIDENCY = defineProcedure({
  ...base,
  name: 'academy.decideResidency',
  kind: 'mutation',
  path: 'decideResidency',
  access: { caller: 'scope', scope: 'admin:write', module: 'academy' },
  refusals: { 'academy.residency_not_found': 'NOT_FOUND', 'academy.residency_not_pending': 'CONFLICT' },
  input: z.object({
    id: z.string().guid(),
    decision: z.enum(['accepted', 'rejected']),
    note: z.string().max(500).optional(),
    ...operatorApprovalIds,
  }),
  output: residencyOut.extend({ confirmOperatorId: z.string() }),
  samples: [
    { verdict: 'accept', input: { id: '33333333-3333-4333-8333-333333333333', decision: 'accepted' } },
    { verdict: 'refuse', input: 42 },
  ],
});
