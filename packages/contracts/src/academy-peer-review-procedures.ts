import { defineProcedure } from './procedure.js';
import { academyPeerReviewInputSchema, academyReviewStateSchema } from './academy-courses.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-academy `peerReview.*`, one record per call: svc-academy mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-academy', module: 'academy', transport: 'trpc' } as const;

/** AC-assignments-03: the caller's review stage; hands them the next classmate's work when one is due and free. */
export const ACADEMY_PEER_REVIEW = defineProcedure({
  ...base,
  name: 'academy.peerReview',
  kind: 'mutation',
  path: 'peerReview',
  access: { caller: 'scope', scope: 'academy:write', module: 'academy' },
  refusals: {
    'academy.assignment_not_found': 'NOT_FOUND',
    'academy.enrolment_required': 'FORBIDDEN',
    'academy.not_released_yet': 'PRECONDITION_FAILED',
    'academy.peer_count_unset': 'BAD_REQUEST',
    'academy.prerequisite_unmet': 'PRECONDITION_FAILED',
  },
  input: academyPeerReviewInputSchema,
  output: academyReviewStateSchema,
  outputChecks: { academy_rubric_criterion_holds: { at: 'output.task.criteria[]', says: 'levels go up, with no two alike' } },
  samples: [
    { verdict: 'accept', input: { itemId: '33333333-3333-4333-8333-333333333333' } },
    { verdict: 'refuse', input: 42 },
  ],
});
