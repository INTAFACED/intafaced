import { defineProcedure } from './procedure.js';
import { academyLeaveAuthoredCourseInputSchema } from './academy-courses.js';
import { academyAuthoredCourseEnrolmentSchema } from './academy-catalogue.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-academy `.*`, one record per call: svc-academy mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-academy', module: 'academy', transport: 'trpc' } as const;

/** AC-enrolment-01: leave the enrolment that began at `enrolledAt`; a repeat is the same leave. */
export const ACADEMY_LEAVE_AUTHORED_COURSE = defineProcedure({
  ...base,
  name: 'academy.leaveAuthoredCourse',
  kind: 'mutation',
  path: 'leaveAuthoredCourse',
  access: { caller: 'scope', scope: 'academy:write', module: 'academy' },
  refusals: {
    'academy.course_not_found': 'NOT_FOUND',
    'academy.enrolment_closed': 'PRECONDITION_FAILED',
    'academy.payment_required': 'FORBIDDEN',
  },
  input: academyLeaveAuthoredCourseInputSchema,
  output: academyAuthoredCourseEnrolmentSchema,
  outputChecks: { enrolment_terms_holds: { at: 'output', says: 'seatsRemaining is set exactly when a seat cap is' } },
  samples: [
    { verdict: 'accept', input: { slug: 'placeholder', enrolledAt: '2026-01-01T00:00:00.000Z' } },
    { verdict: 'refuse', input: 42 },
  ],
});
