import { defineProcedure } from './procedure.js';
import {
  kybDocumentFileInputSchema,
  kybDocumentFileSchema,
  kybDocumentReviewViewInputSchema,
  kybDocumentReviewViewSchema,
} from './kyb-documents.js';
import {
  kybRequestFileBytesSchema,
  kybRequestFileInputSchema,
  kybRequestsListInputSchema,
  kybRequestsViewSchema,
} from './kyb-information-requests.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-pay `kyb.*`, one record per call: svc-pay mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-pay', module: 'pay', transport: 'trpc' } as const;

/** Compliance: the bytes of one upload, so the reviewer can read it. A mutation, because every read is recorded. */
export const PAY_KYB_DOCUMENTS_FILE = defineProcedure({
  ...base,
  name: 'pay.kyb.documents.file',
  kind: 'mutation',
  path: 'kyb.documents.file',
  access: { caller: 'scope', scope: 'admin:compliance', module: 'pay' },
  refusals: {},
  input: kybDocumentFileInputSchema,
  output: kybDocumentFileSchema,
  samples: [
    {
      verdict: 'accept',
      input: { applicationId: '11111111-1111-4111-8111-111111111111', documentId: '11111111-1111-4111-8111-111111111111' },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

/** For compliance: the decrypted bytes of an answer's file. Each read is recorded. */
export const PAY_KYB_REQUESTS_FILE = defineProcedure({
  ...base,
  name: 'pay.kyb.requests.file',
  kind: 'mutation',
  path: 'kyb.requests.file',
  access: { caller: 'scope', scope: 'admin:compliance', module: 'pay' },
  refusals: {},
  input: kybRequestFileInputSchema,
  output: kybRequestFileBytesSchema,
  samples: [
    { verdict: 'accept', input: { requestId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** For compliance: one merchant's requests. */
export const PAY_KYB_REQUESTS_REVIEW_LIST = defineProcedure({
  ...base,
  name: 'pay.kyb.requests.reviewList',
  kind: 'query',
  path: 'kyb.requests.reviewList',
  access: { caller: 'scope', scope: 'admin:compliance', module: 'pay' },
  refusals: {},
  input: kybRequestsListInputSchema,
  output: kybRequestsViewSchema,
  samples: [
    { verdict: 'accept', input: { merchantId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** Compliance: a merchant's current application and each document, with who gave each verdict. Interactive sign-in with a second factor. */
export const PAY_KYB_DOCUMENTS_REVIEW_VIEW = defineProcedure({
  ...base,
  name: 'pay.kyb.documents.reviewView',
  kind: 'query',
  path: 'kyb.documents.reviewView',
  access: { caller: 'scope', scope: 'admin:compliance', module: 'pay' },
  refusals: {},
  input: kybDocumentReviewViewInputSchema,
  output: kybDocumentReviewViewSchema,
  samples: [
    { verdict: 'accept', input: { merchantId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});
