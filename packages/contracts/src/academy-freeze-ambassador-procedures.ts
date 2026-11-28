import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { operatorApprovalIds } from './academy-appoint-ambassador-procedures.js';
import { ambassadorOut } from './academy-ambassadors-procedures.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-academy `freezeAmbassador.*`, one record per call: svc-academy mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-academy', module: 'academy', transport: 'trpc' } as const;

export const ACADEMY_FREEZE_AMBASSADOR = defineProcedure({
  ...base,
  name: 'academy.freezeAmbassador',
  kind: 'mutation',
  path: 'freezeAmbassador',
  access: { caller: 'scope', scope: 'admin:write', module: 'academy' },
  refusals: {
    'academy.ambassador_already_frozen': 'CONFLICT',
    'academy.ambassador_invalid': 'BAD_REQUEST',
    'academy.ambassador_not_found': 'NOT_FOUND',
  },
  input: z.object({ userId: z.string().guid(), reason: z.string().min(1).max(500), ...operatorApprovalIds }),
  output: ambassadorOut.extend({ confirmOperatorId: z.string() }),
  samples: [
    { verdict: 'accept', input: { userId: '33333333-3333-4333-8333-333333333333', reason: 'placeholder' } },
    { verdict: 'refuse', input: 42 },
  ],
});
