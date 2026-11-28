import { defineProcedure } from './procedure.js';
import { academyReviewStateSchema, academySubmitPeerReviewInputSchema } from './academy-courses.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-academy `.*`, one record per call: svc-academy mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-academy', module: 'academy', transport: 'trpc' } as const;

/** AC-assignments-03: one review's marks, keyed `peer:<assignment>:<reviewer>:<author>`; the same marks answer as stored. */
export const ACADEMY_SUBMIT_PEER_REVIEW = defineProcedure({
  ...base,
  name: 'academy.submitPeerReview',
  kind: 'mutation',
  path: 'submitPeerReview',
  access: { caller: 'scope', scope: 'academy:write', module: 'academy' },
  refusals: {
    'academy.assignment_not_found': 'NOT_FOUND',
    'academy.enrolment_required': 'FORBIDDEN',
    'academy.not_released_yet': 'PRECONDITION_FAILED',
    'academy.peer_count_unset': 'BAD_REQUEST',
    'academy.prerequisite_unmet': 'PRECONDITION_FAILED',
    'academy.review_already_sent': 'CONFLICT',
    'academy.review_marks_invalid': 'BAD_REQUEST',
    'academy.review_task_not_found': 'NOT_FOUND',
  },
  input: academySubmitPeerReviewInputSchema,
  output: academyReviewStateSchema,
  outputChecks: { academy_rubric_criterion_holds: { at: 'output.task.criteria[]', says: 'levels go up, with no two alike' } },
  samples: [
    {
      verdict: 'accept',
      input: { itemId: '11111111-1111-4111-8111-111111111111', taskId: '11111111-1111-4111-8111-111111111111', marks: ['1'] },
    },
    { verdict: 'refuse', input: 42 },
  ],
});
