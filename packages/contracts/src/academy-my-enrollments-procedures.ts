import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-academy `myEnrollments.*`, one record per call: svc-academy mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-academy', module: 'academy', transport: 'trpc' } as const;

export const enrollmentOut = z.object({
  userId: z.string().guid(),
  pathSlug: z.string(),
  enrolledAt: z.iso.datetime({ offset: true }),
});

export const ACADEMY_MY_ENROLLMENTS = defineProcedure({
  ...base,
  name: 'academy.myEnrollments',
  kind: 'query',
  path: 'myEnrollments',
  access: { caller: 'scope', scope: 'academy:read', module: 'academy' },
  refusals: {},
  input: NO_INPUT,
  output: z.array(enrollmentOut),
  samples: [{ verdict: 'accept' }],
});
