import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { ambassadorStatus, operatorApprovalIds } from './academy-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-academy `.*`, one record per call: svc-academy mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-academy', module: 'academy', transport: 'trpc' } as const;

export const ambassadorOut = z.object({
  userId: z.string().guid(),
  status: ambassadorStatus,
  appointedBy: z.string().guid(),
  appointedAt: z.iso.datetime({ offset: true }),
  frozenAt: z.iso.datetime({ offset: true }).nullable(),
  frozenBy: z.string().guid().nullable(),
  freezeReason: z.string().nullable(),
});

/** Reactivate a frozen ambassador without re-appoint (clear freeze reason). */
export const ACADEMY_UNFREEZE_AMBASSADOR = defineProcedure({
  ...base,
  name: 'academy.unfreezeAmbassador',
  kind: 'mutation',
  path: 'unfreezeAmbassador',
  access: { caller: 'scope', scope: 'admin:write', module: 'academy' },
  refusals: {
    'academy.ambassador_already_active': 'CONFLICT',
    'academy.ambassador_already_frozen': 'CONFLICT',
    'academy.ambassador_invalid': 'BAD_REQUEST',
    'academy.ambassador_not_found': 'NOT_FOUND',
  },
  input: z.object({ userId: z.string().guid(), ...operatorApprovalIds }),
  output: ambassadorOut.extend({ confirmOperatorId: z.string() }),
  samples: [
    { verdict: 'accept', input: { userId: '33333333-3333-4333-8333-333333333333' } },
    { verdict: 'refuse', input: 42 },
  ],
});
