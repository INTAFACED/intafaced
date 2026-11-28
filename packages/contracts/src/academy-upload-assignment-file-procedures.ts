import { defineProcedure } from './procedure.js';
import { academySubmissionFileSchema, academyUploadAssignmentFileInputSchema } from './academy-courses.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-academy `uploadAssignmentFile.*`, one record per call: svc-academy mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-academy', module: 'academy', transport: 'trpc' } as const;

/** AC-assignments-01: a file for the next hand-in, checked against the owner's limits; the same file is the same row. */
export const ACADEMY_UPLOAD_ASSIGNMENT_FILE = defineProcedure({
  ...base,
  name: 'academy.uploadAssignmentFile',
  kind: 'mutation',
  path: 'uploadAssignmentFile',
  access: { caller: 'scope', scope: 'academy:write', module: 'academy' },
  refusals: {
    'academy.assignment_closed': 'CONFLICT',
    'academy.assignment_not_found': 'NOT_FOUND',
    'academy.enrolment_required': 'FORBIDDEN',
    'academy.file_type_mismatch': 'BAD_REQUEST',
    'academy.not_released_yet': 'PRECONDITION_FAILED',
    'academy.prerequisite_unmet': 'PRECONDITION_FAILED',
    'academy.upload_incomplete': 'PRECONDITION_FAILED',
    'academy.upload_limits_unset': 'PRECONDITION_FAILED',
    'academy.upload_too_large': 'BAD_REQUEST',
    'academy.upload_type_refused': 'BAD_REQUEST',
    'academy.video_grant_required': 'FORBIDDEN',
    'academy.video_s3_region_unset': 'PRECONDITION_FAILED',
    'academy.video_storage_unconfigured': 'PRECONDITION_FAILED',
    'academy.video_url_ttl_unset': 'PRECONDITION_FAILED',
  },
  input: academyUploadAssignmentFileInputSchema,
  output: academySubmissionFileSchema,
  samples: [
    {
      verdict: 'accept',
      input: {
        itemId: '33333333-3333-4333-8333-333333333333',
        fileName: 'placeholder',
        contentType: 'placeholder',
        contentBase64: 'placeholder',
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});
