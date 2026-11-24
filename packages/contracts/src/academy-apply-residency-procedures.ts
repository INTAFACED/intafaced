import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { residencyOut } from './academy-open-residencies-procedures.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-academy `applyResidency.*`, one record per call: svc-academy mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-academy', module: 'academy', transport: 'trpc' } as const;

export const ACADEMY_APPLY_RESIDENCY = defineProcedure({
  ...base,
  name: 'academy.applyResidency',
  kind: 'mutation',
  path: 'applyResidency',
  access: { caller: 'scope', scope: 'academy:write', module: 'academy' },
  refusals: { 'academy.residency_already_open': 'CONFLICT', 'academy.residency_invalid': 'BAD_REQUEST' },
  input: z.object({ cohortSlug: z.string().min(3).max(48), statement: z.string().min(20).max(2000) }),
  output: residencyOut,
  samples: [
    { verdict: 'accept', input: { cohortSlug: 'placeholder', statement: 'placeholderxxxxxxxxx' } },
    { verdict: 'refuse', input: 42 },
  ],
});
