import { defineProcedure } from './procedure.js';
import { academyAuthoredCourseInputSchema, academyCourseLearnerViewSchema } from './academy-courses.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-academy `authoredCourse.*`, one record per call: svc-academy mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-academy', module: 'academy', transport: 'trpc' } as const;

/** AC-catalogue-03: a published course staff made, as the caller sees it: their enrolment opens what is released. */
export const ACADEMY_AUTHORED_COURSE = defineProcedure({
  ...base,
  name: 'academy.authoredCourse',
  kind: 'query',
  path: 'authoredCourse',
  access: { caller: 'scope', scope: 'academy:read', module: 'academy' },
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
