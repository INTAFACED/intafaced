import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';
import { academyPublicCourseCardSchema } from './academy-catalogue.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-academy `publicCourses.*`, one record per call: svc-academy mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-academy', module: 'academy', transport: 'trpc' } as const;

/** AC-catalogue-03: one card per course with published items. A course is one curriculum path until courses are rows. */
export const ACADEMY_PUBLIC_COURSES = defineProcedure({
  ...base,
  name: 'academy.publicCourses',
  kind: 'query',
  path: 'publicCourses',
  access: { caller: 'public' },
  refusals: { 'academy.slug_reserved': 'BAD_REQUEST' },
  input: NO_INPUT,
  output: z.array(academyPublicCourseCardSchema),
  samples: [{ verdict: 'accept' }],
});
