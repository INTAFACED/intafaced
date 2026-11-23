import { defineProcedure } from './procedure.js';
import { academyPublishedCourseListSchema, academyPublishedCoursesInputSchema } from './academy-courses.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-academy `publicAuthoredCourses.*`, one record per call: svc-academy mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-academy', module: 'academy', transport: 'trpc' } as const;

/** AC-catalogue-03: the published courses staff made, newest first, up to the page asked for. */
export const ACADEMY_PUBLIC_AUTHORED_COURSES = defineProcedure({
  ...base,
  name: 'academy.publicAuthoredCourses',
  kind: 'query',
  path: 'publicAuthoredCourses',
  access: { caller: 'public' },
  refusals: {
    'academy.course_not_found': 'NOT_FOUND',
    'academy.enrolment_closed': 'PRECONDITION_FAILED',
    'academy.payment_required': 'FORBIDDEN',
  },
  input: academyPublishedCoursesInputSchema,
  output: academyPublishedCourseListSchema,
  samples: [
    { verdict: 'accept', input: { limit: 1 } },
    { verdict: 'refuse', input: 42 },
  ],
});
