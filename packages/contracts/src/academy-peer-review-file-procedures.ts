import { defineProcedure } from './procedure.js';
import { academyPeerReviewFileInputSchema, academyPeerReviewFileSchema } from './academy-courses.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-academy `peerReviewFile.*`, one record per call: svc-academy mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-academy', module: 'academy', transport: 'trpc' } as const;

/** AC-assignments-03: the file of work handed to the caller to review, read back so its store address stays hidden. */
export const ACADEMY_PEER_REVIEW_FILE = defineProcedure({
  ...base,
  name: 'academy.peerReviewFile',
  kind: 'query',
  path: 'peerReviewFile',
  access: { caller: 'scope', scope: 'academy:read', module: 'academy' },
  refusals: {
    'academy.assignment_not_found': 'NOT_FOUND',
    'academy.enrolment_required': 'FORBIDDEN',
    'academy.file_unavailable': 'PRECONDITION_FAILED',
    'academy.not_released_yet': 'PRECONDITION_FAILED',
    'academy.prerequisite_unmet': 'PRECONDITION_FAILED',
    'academy.review_task_not_found': 'NOT_FOUND',
    'academy.video_grant_required': 'FORBIDDEN',
    'academy.video_s3_region_unset': 'PRECONDITION_FAILED',
    'academy.video_storage_unconfigured': 'PRECONDITION_FAILED',
    'academy.video_url_ttl_unset': 'PRECONDITION_FAILED',
  },
  input: academyPeerReviewFileInputSchema,
  output: academyPeerReviewFileSchema,
  samples: [
    { verdict: 'accept', input: { itemId: '33333333-3333-4333-8333-333333333333', taskId: '33333333-3333-4333-8333-333333333333' } },
    { verdict: 'refuse', input: 42 },
  ],
});
