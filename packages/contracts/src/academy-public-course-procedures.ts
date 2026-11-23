import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { academyPublicCourseSchema } from './academy-catalogue.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-academy `publicCourse.*`, one record per call: svc-academy mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-academy', module: 'academy', transport: 'trpc' } as const;

/** The public course page. Unknown and unpublished courses give the same `academy.course_not_found`. */
export const ACADEMY_PUBLIC_COURSE = defineProcedure({
  ...base,
  name: 'academy.publicCourse',
  kind: 'query',
  path: 'publicCourse',
  access: { caller: 'public' },
  refusals: {
    'academy.course_not_found': 'NOT_FOUND',
    'academy.curriculum_not_found': 'NOT_FOUND',
    'academy.prerequisite_unmet': 'PRECONDITION_FAILED',
    'academy.sign_in_required': 'FORBIDDEN',
    'academy.slug_reserved': 'BAD_REQUEST',
    'academy.window_invalid': 'BAD_REQUEST',
  },
  input: z.object({ slug: z.string().min(1).max(120) }).strict(),
  output: academyPublicCourseSchema,
  samples: [
    { verdict: 'accept', input: { slug: 'placeholder' } },
    { verdict: 'refuse', input: 42 },
  ],
});
