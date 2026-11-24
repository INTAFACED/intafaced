import { defineProcedure } from './procedure.js';
import { academyCourseByLinkInputSchema, academyCourseLearnerViewSchema } from './academy-courses.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-academy `publicCourseByLink.*`, one record per call: svc-academy mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-academy', module: 'academy', transport: 'trpc' } as const;

/**
 * AC-catalogue-03: a course's unlisted page through a private link; anything else is `academy.course_not_found`. A
 * POST so the key travels in the body, never in a URL the edge logs. It writes nothing.
 */
export const ACADEMY_PUBLIC_COURSE_BY_LINK = defineProcedure({
  ...base,
  name: 'academy.publicCourseByLink',
  kind: 'mutation',
  path: 'publicCourseByLink',
  access: { caller: 'public' },
  refusals: { 'academy.course_not_found': 'NOT_FOUND' },
  input: academyCourseByLinkInputSchema,
  output: academyCourseLearnerViewSchema,
  samples: [
    { verdict: 'accept', input: { slug: 'placeholder', key: 'placeholder' } },
    { verdict: 'refuse', input: 42 },
  ],
});
