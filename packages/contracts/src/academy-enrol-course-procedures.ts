import { defineProcedure } from './procedure.js';
import { academyCourseEnrolmentSchema, academyEnrolCourseInputSchema } from './academy-catalogue.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-academy `.*`, one record per call: svc-academy mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-academy', module: 'academy', transport: 'trpc' } as const;

/** AC-enrolment-01: Enrol now from a course page. A repeat while enrolled answers with the same enrolment. */
export const ACADEMY_ENROL_COURSE = defineProcedure({
  ...base,
  name: 'academy.enrolCourse',
  kind: 'mutation',
  path: 'enrolCourse',
  access: { caller: 'scope', scope: 'academy:write', module: 'academy' },
  refusals: {
    'academy.cert_invalid': 'BAD_REQUEST',
    'academy.course_not_found': 'NOT_FOUND',
    'academy.enrolment_closed': 'PRECONDITION_FAILED',
    'academy.slug_reserved': 'BAD_REQUEST',
  },
  input: academyEnrolCourseInputSchema,
  output: academyCourseEnrolmentSchema,
  outputChecks: { enrolment_terms_holds: { at: 'output', says: 'seatsRemaining is set exactly when a seat cap is' } },
  samples: [
    { verdict: 'accept', input: { slug: 'placeholder', track: 'audit' } },
    { verdict: 'refuse', input: 42 },
  ],
});
