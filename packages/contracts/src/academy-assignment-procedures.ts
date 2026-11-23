import { defineProcedure } from './procedure.js';
import { academyAssignmentInputSchema, academyAssignmentViewSchema } from './academy-courses.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-academy `.*`, one record per call: svc-academy mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-academy', module: 'academy', transport: 'trpc' } as const;

/** AC-assignments-01: an assignment as the enrolled learner sees it, with their own hand-ins, newest first. */
export const ACADEMY_ASSIGNMENT = defineProcedure({
  ...base,
  name: 'academy.assignment',
  kind: 'query',
  path: 'assignment',
  access: { caller: 'scope', scope: 'academy:read', module: 'academy' },
  refusals: {
    'academy.assignment_not_found': 'NOT_FOUND',
    'academy.enrolment_required': 'FORBIDDEN',
    'academy.not_released_yet': 'PRECONDITION_FAILED',
    'academy.prerequisite_unmet': 'PRECONDITION_FAILED',
  },
  input: academyAssignmentInputSchema,
  output: academyAssignmentViewSchema,
  outputChecks: { academy_points_holds: { at: 'output.points', says: 'points are more than zero' } },
  samples: [
    { verdict: 'accept', input: { itemId: '33333333-3333-4333-8333-333333333333' } },
    { verdict: 'refuse', input: 42 },
  ],
});
