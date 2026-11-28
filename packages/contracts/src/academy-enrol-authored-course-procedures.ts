import { defineProcedure } from './procedure.js';
import { academyAuthoredCourseEnrolmentSchema, academyEnrolCourseInputSchema } from './academy-catalogue.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-academy `.*`, one record per call: svc-academy mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-academy', module: 'academy', transport: 'trpc' } as const;

/** AC-enrolment-01: enrol on the free track, keyed `enrol:<user>:<course>`; a closed track refuses `academy.enrolment_closed`. */
export const ACADEMY_ENROL_AUTHORED_COURSE = defineProcedure({
  ...base,
  name: 'academy.enrolAuthoredCourse',
  kind: 'mutation',
  path: 'enrolAuthoredCourse',
  access: { caller: 'scope', scope: 'academy:write', module: 'academy' },
  refusals: {
    'academy.course_not_found': 'NOT_FOUND',
    'academy.enrolment_closed': 'PRECONDITION_FAILED',
    'academy.payment_required': 'FORBIDDEN',
  },
  input: academyEnrolCourseInputSchema,
  output: academyAuthoredCourseEnrolmentSchema,
  outputChecks: { enrolment_terms_holds: { at: 'output', says: 'seatsRemaining is set exactly when a seat cap is' } },
  samples: [
    { verdict: 'accept', input: { slug: 'placeholder', track: 'audit' } },
    { verdict: 'refuse', input: 42 },
  ],
});
