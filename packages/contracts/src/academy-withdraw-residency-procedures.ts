import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { residencyOut } from './academy-open-residencies-procedures.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-academy `withdrawResidency.*`, one record per call: svc-academy mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-academy', module: 'academy', transport: 'trpc' } as const;

export const ACADEMY_WITHDRAW_RESIDENCY = defineProcedure({
  ...base,
  name: 'academy.withdrawResidency',
  kind: 'mutation',
  path: 'withdrawResidency',
  access: { caller: 'scope', scope: 'academy:write', module: 'academy' },
  refusals: { 'academy.residency_not_found': 'NOT_FOUND', 'academy.residency_not_pending': 'CONFLICT' },
  input: z.object({ id: z.string().guid() }),
  output: residencyOut,
  samples: [
    { verdict: 'accept', input: { id: '33333333-3333-4333-8333-333333333333' } },
    { verdict: 'refuse', input: 42 },
  ],
});
