import { defineProcedure } from './procedure.js';
import { academyAssignmentViewSchema, academySubmitAssignmentInputSchema } from './academy-courses.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-academy `.*`, one record per call: svc-academy mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-academy', module: 'academy', transport: 'trpc' } as const;

/** AC-assignments-01: hand in version n, keyed `submit:<item>:<account>:<n>`; a retry returns the stored hand-in. */
export const ACADEMY_SUBMIT_ASSIGNMENT = defineProcedure({
  ...base,
  name: 'academy.submitAssignment',
  kind: 'mutation',
  path: 'submitAssignment',
  access: { caller: 'scope', scope: 'academy:write', module: 'academy' },
  refusals: {
    'academy.assignment_closed': 'CONFLICT',
    'academy.assignment_not_found': 'NOT_FOUND',
    'academy.enrolment_required': 'FORBIDDEN',
    'academy.media_not_found': 'NOT_FOUND',
    'academy.not_released_yet': 'PRECONDITION_FAILED',
    'academy.prerequisite_unmet': 'PRECONDITION_FAILED',
    'academy.submission_incomplete': 'BAD_REQUEST',
    'academy.submission_version_stale': 'CONFLICT',
  },
  input: academySubmitAssignmentInputSchema,
  output: academyAssignmentViewSchema,
  outputChecks: { academy_points_holds: { at: 'output.points', says: 'points are more than zero' } },
  samples: [
    {
      verdict: 'accept',
      input: {
        itemId: '33333333-3333-4333-8333-333333333333',
        version: 1,
        text: 'placeholder',
        fileId: '33333333-3333-4333-8333-333333333333',
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});
