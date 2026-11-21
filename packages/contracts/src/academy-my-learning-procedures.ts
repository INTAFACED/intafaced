import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';
import { academyMyCourseSchema } from './academy-catalogue.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-academy `myLearning.*`, one record per call: svc-academy mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-academy', module: 'academy', transport: 'trpc' } as const;

/** AC-catalogue-02: My learning, the caller's enrolled courses with real progress and where Continue goes. */
export const ACADEMY_MY_LEARNING = defineProcedure({
  ...base,
  name: 'academy.myLearning',
  kind: 'query',
  path: 'myLearning',
  access: { caller: 'scope', scope: 'academy:read', module: 'academy' },
  refusals: { 'academy.curriculum_not_found': 'NOT_FOUND', 'academy.slug_reserved': 'BAD_REQUEST' },
  input: NO_INPUT,
  output: z.array(academyMyCourseSchema),
  outputChecks: { academy_my_course_holds: { at: 'output[]', says: 'more items completed than the course has' } },
  samples: [{ verdict: 'accept' }],
});
