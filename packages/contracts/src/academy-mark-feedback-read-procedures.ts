import { defineProcedure } from './procedure.js';
import { academyAssignmentViewSchema, academyMarkFeedbackReadInputSchema } from './academy-courses.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-academy `.*`, one record per call: svc-academy mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-academy', module: 'academy', transport: 'trpc' } as const;

/** AC-assignments-02: the caller read the feedback on one of their graded hand-ins; changes no grade. */
export const ACADEMY_MARK_FEEDBACK_READ = defineProcedure({
  ...base,
  name: 'academy.markFeedbackRead',
  kind: 'mutation',
  path: 'markFeedbackRead',
  access: { caller: 'scope', scope: 'academy:write', module: 'academy' },
  refusals: {
    'academy.assignment_not_found': 'NOT_FOUND',
    'academy.enrolment_required': 'FORBIDDEN',
    'academy.not_released_yet': 'PRECONDITION_FAILED',
    'academy.prerequisite_unmet': 'PRECONDITION_FAILED',
    'academy.submission_not_found': 'NOT_FOUND',
  },
  input: academyMarkFeedbackReadInputSchema,
  output: academyAssignmentViewSchema,
  outputChecks: { academy_points_holds: { at: 'output.points', says: 'points are more than zero' } },
  samples: [
    { verdict: 'accept', input: { itemId: '33333333-3333-4333-8333-333333333333', version: 1, n: 1 } },
    { verdict: 'refuse', input: 42 },
  ],
});
