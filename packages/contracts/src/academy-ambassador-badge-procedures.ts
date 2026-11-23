import { z } from 'zod';
import { defineProcedure } from './procedure.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-academy `ambassadorBadge.*`, one record per call: svc-academy mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-academy', module: 'academy', transport: 'trpc' } as const;

export const ambassadorStatus = z.enum(['active', 'frozen']);

export const ambassadorBadgeOut = z.object({
  userId: z.string().guid(),
  isAmbassador: z.boolean(),
  status: ambassadorStatus.nullable(),
});

export const ACADEMY_AMBASSADOR_BADGE = defineProcedure({
  ...base,
  name: 'academy.ambassadorBadge',
  kind: 'query',
  path: 'ambassadorBadge',
  access: { caller: 'scope', scope: 'academy:read', module: 'academy' },
  refusals: {},
  input: z.object({ userId: z.string().guid() }),
  output: ambassadorBadgeOut,
  samples: [
    { verdict: 'accept', input: { userId: '33333333-3333-4333-8333-333333333333' } },
    { verdict: 'refuse', input: 42 },
  ],
});
