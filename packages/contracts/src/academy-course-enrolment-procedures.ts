import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { academyCourseEnrolmentSchema } from './academy-catalogue.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-academy `.*`, one record per call: svc-academy mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-academy', module: 'academy', transport: 'trpc' } as const;

/** AC-enrolment-01: the terms of enrolling in a course (tracks, start date, seats, closed reason) and the caller's own enrolment. */
export const ACADEMY_COURSE_ENROLMENT = defineProcedure({
  ...base,
  name: 'academy.courseEnrolment',
  kind: 'query',
  path: 'courseEnrolment',
  access: { caller: 'scope', scope: 'academy:read', module: 'academy' },
  refusals: { 'academy.course_not_found': 'NOT_FOUND', 'academy.slug_reserved': 'BAD_REQUEST' },
  input: z.object({ slug: z.string().min(1).max(64) }).strict(),
  output: academyCourseEnrolmentSchema,
  outputChecks: { enrolment_terms_holds: { at: 'output', says: 'seatsRemaining is set exactly when a seat cap is' } },
  samples: [
    { verdict: 'accept', input: { slug: 'placeholder' } },
    { verdict: 'refuse', input: 42 },
  ],
});
