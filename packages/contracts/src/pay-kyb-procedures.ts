import { defineProcedure, NO_INPUT } from './procedure.js';
import {
  kybDocumentFileInputSchema,
  kybDocumentFileSchema,
  kybDocumentReviewViewInputSchema,
  kybDocumentReviewViewSchema,
  kybDocumentsChecklistInputSchema,
  kybDocumentChecklistViewSchema,
  kybDocumentsUploadInputSchema,
  kybDocumentsUploadResultSchema,
} from './kyb-documents.js';
import {
  kybRequestFileBytesSchema,
  kybRequestFileInputSchema,
  kybRequestsListInputSchema,
  kybRequestsViewSchema,
} from './kyb-information-requests.js';
import { kybEntityTypesViewSchema } from './kyb-entity-types.js';
import {
  kybApplicationCurrentInputSchema,
  kybApplicationViewSchema,
  kybApplicationRestartInputSchema,
  kybApplicationSubmitInputSchema,
} from './kyb-application.js';

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

/**
 * The entity types the owner has published, each with the documents, people roles and questionnaires it
 * requires and the countries it is offered in. Empty when none are published. The door is `pay:onboard`
 * because a business reads this before it has a merchant row; nothing here names a merchant.
 */
export const PAY_KYB_ENTITY_TYPES_READ = defineProcedure({
  ...base,
  name: 'pay.kyb.entityTypes.read',
  kind: 'query',
  path: 'kyb.entityTypes.read',
  access: { caller: 'scope', scope: 'pay:onboard', module: 'pay' },
  refusals: {},
  input: NO_INPUT,
  output: kybEntityTypesViewSchema,
  samples: [{ verdict: 'accept' }],
});

/** The merchant's open draft, or its latest submitted application; null when none was started. */
export const PAY_KYB_APPLICATION_CURRENT = defineProcedure({
  ...base,
  name: 'pay.kyb.application.current',
  kind: 'query',
  path: 'kyb.application.current',
  access: { caller: 'scope', scope: 'pay:onboard', module: 'pay' },
  refusals: {},
  input: kybApplicationCurrentInputSchema,
  output: kybApplicationViewSchema.nullable(),
  outputChecks: { kyb_application_section_data_holds: { at: 'output.sections[].data', says: 'a section holds at most 100 fields' } },
  samples: [
    { verdict: 'accept', input: { merchantId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** Clear the draft's sections (needs `confirm: true`). The history of earlier saves is kept. */
export const PAY_KYB_APPLICATION_RESTART = defineProcedure({
  ...base,
  name: 'pay.kyb.application.restart',
  kind: 'mutation',
  path: 'kyb.application.restart',
  access: { caller: 'scope', scope: 'pay:onboard', module: 'pay' },
  refusals: {},
  input: kybApplicationRestartInputSchema,
  output: kybApplicationViewSchema,
  outputChecks: { kyb_application_section_data_holds: { at: 'output.sections[].data', says: 'a section holds at most 100 fields' } },
  samples: [
    { verdict: 'accept', input: { applicationId: '11111111-1111-4111-8111-111111111111', confirm: true } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** Submit once every required section is complete (`pay.kyb_incomplete` names the rest). Moves KYB to pending. */
export const PAY_KYB_APPLICATION_SUBMIT = defineProcedure({
  ...base,
  name: 'pay.kyb.application.submit',
  kind: 'mutation',
  path: 'kyb.application.submit',
  access: { caller: 'scope', scope: 'pay:onboard', module: 'pay' },
  refusals: {},
  input: kybApplicationSubmitInputSchema,
  output: kybApplicationViewSchema,
  outputChecks: { kyb_application_section_data_holds: { at: 'output.sections[].data', says: 'a section holds at most 100 fields' } },
  samples: [
    { verdict: 'accept', input: { applicationId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** What the application's type requires, each document's state, the owner's upload rules, and the automatic check (`vendor.kyc`, not connected). */
export const PAY_KYB_DOCUMENTS_CHECKLIST = defineProcedure({
  ...base,
  name: 'pay.kyb.documents.checklist',
  kind: 'query',
  path: 'kyb.documents.checklist',
  access: { caller: 'scope', scope: 'pay:onboard', module: 'pay' },
  refusals: {},
  input: kybDocumentsChecklistInputSchema,
  output: kybDocumentChecklistViewSchema,
  samples: [
    { verdict: 'accept', input: { applicationId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** Upload one required document to an open draft. Refuses without published upload rules or an encryption key, a wrong type, or an oversize file. */
export const PAY_KYB_DOCUMENTS_UPLOAD = defineProcedure({
  ...base,
  name: 'pay.kyb.documents.upload',
  kind: 'mutation',
  path: 'kyb.documents.upload',
  access: { caller: 'scope', scope: 'pay:onboard', module: 'pay' },
  refusals: {},
  input: kybDocumentsUploadInputSchema,
  output: kybDocumentsUploadResultSchema,
  samples: [
    {
      verdict: 'accept',
      input: { applicationId: '11111111-1111-4111-8111-111111111111', key: 'abc', contentType: 'USDC', bytesBase64: 'USDC' },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

/** The business's requests, newest first, each with its due date, answer and who closed it. */
export const PAY_KYB_REQUESTS_LIST = defineProcedure({
  ...base,
  name: 'pay.kyb.requests.list',
  kind: 'query',
  path: 'kyb.requests.list',
  access: { caller: 'scope', scope: 'pay:onboard', module: 'pay' },
  refusals: {},
  input: kybRequestsListInputSchema,
  output: kybRequestsViewSchema,
  samples: [
    { verdict: 'accept', input: { merchantId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});
