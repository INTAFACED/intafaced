import { defineProcedure } from './procedure.js';
import { academyAuthoredCourseInputSchema, academyCourseLearnerViewSchema } from './academy-courses.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-academy `publicAuthoredCourse.*`, one record per call: svc-academy mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-academy', module: 'academy', transport: 'trpc' } as const;

/** AC-catalogue-03: a published course's public page; anything else is `academy.course_not_found`. Writes nothing. */
export const ACADEMY_PUBLIC_AUTHORED_COURSE = defineProcedure({
  ...base,
  name: 'academy.publicAuthoredCourse',
  kind: 'query',
  path: 'publicAuthoredCourse',
  access: { caller: 'public' },
  refusals: {
    'academy.course_not_found': 'NOT_FOUND',
    'academy.enrolment_closed': 'PRECONDITION_FAILED',
    'academy.payment_required': 'FORBIDDEN',
  },
  input: academyAuthoredCourseInputSchema,
  output: academyCourseLearnerViewSchema,
  samples: [
    { verdict: 'accept', input: { slug: 'placeholder' } },
    { verdict: 'refuse', input: 42 },
  ],
});
