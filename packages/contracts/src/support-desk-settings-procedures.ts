import { z } from 'zod';
import { defineProcedure, NO_INPUT, type Refusals, type RefusalStatus } from './procedure.js';
import { supportKbArticleSchema } from './support.js';
import {
  supportAttachmentDownloadSchema,
  supportAttachmentIdInputSchema,
  supportAttachmentLimitsSchema,
  supportAttachmentSchema,
  supportAttachmentSettingsSetInputSchema,
  supportAttachmentStatusSchema,
  supportAttachmentTypesDistinct,
} from './support-attachments.js';
import { supportContactChannelsSchema, supportContactSetInputSchema } from './support-contact.js';
import {
  supportHelpCentreSchema,
  supportHelpCentreTranslationListInputSchema,
  supportHelpCentreTranslationListSchema,
} from './support-help-centre.js';
import { supportKbLibraryIdSchema, supportKbLibrarySchema } from './support-kb-library.js';
import {
  supportKbDraftSaveInputSchema,
  supportKbDraftSchema,
  supportKbHistorySchema,
  supportKbReviewActInputSchema,
  supportKbTemplateSaveInputSchema,
  supportKbTemplateSchema,
} from './support-kb-review.js';
import { supportDisclosureSchema } from './support-read-grants.js';
import {
  supportDisclosureReadInputSchema,
  supportRecordVerificationCheckInputSchema,
  supportTicketOnlyInputSchema,
  supportVerificationCheckSchema,
  supportVerificationChecksSchema,
} from './support-verification-checks.js';

/**
 * svc-support's desk settings and authoring calls, one record per call: help articles written, reviewed and published, a
 * ticket's files added and opened by the operator, the verification checks and the reads behind them, and the attachment,
 * contact and help centre settings. svc-support mounts each from here; the admin desk calls each by its record. The help
 * library, the contact channels and the help centre settings are public reads the customer app makes too.
 */

/** Each refusal by its code, with the status svc-support sends it with (`record-refusal.ts`, `kb-review-router.ts`, `verification-checks-router.ts`). */
const STATUS = {
  // A ticket outside the operator's desk, or none.
  'support.not_found': 'NOT_FOUND',
  'support.ticket_closed': 'PRECONDITION_FAILED',
  // Help articles (`kb-authoring.ts`), each sent by `kb-review-router.ts`'s own table.
  'support.kb_title_blank': 'BAD_REQUEST',
  'support.kb_title_invalid': 'BAD_REQUEST',
  'support.kb_body_invalid': 'BAD_REQUEST',
  'support.kb_vendor_name': 'BAD_REQUEST',
  'support.kb_template_unknown': 'BAD_REQUEST',
  'support.kb_section_unknown': 'PRECONDITION_FAILED',
  'support.kb_revision_stale': 'CONFLICT',
  'support.kb_draft_unknown': 'NOT_FOUND',
  'support.kb_same_operator': 'FORBIDDEN',
  'support.kb_not_in_review': 'PRECONDITION_FAILED',
  'support.kb_not_approved': 'PRECONDITION_FAILED',
  'support.kb_already_in_review': 'PRECONDITION_FAILED',
  'support.kb_template_revision_stale': 'CONFLICT',
  // A ticket's files (`support-service.ts`).
  'support.attachments_unconfigured': 'PRECONDITION_FAILED',
  'support.attachment_body_invalid': 'BAD_REQUEST',
  'support.attachment_type_refused': 'BAD_REQUEST',
  'support.attachment_too_large': 'PRECONDITION_FAILED',
  'support.attachment_count_unset': 'PRECONDITION_FAILED',
  'support.attachment_count_reached': 'PRECONDITION_FAILED',
  'support.attachment_scan_refused': 'PRECONDITION_FAILED',
  'support.attachment_scan_unknown': 'PRECONDITION_FAILED',
  'support.client_request_id_required': 'BAD_REQUEST',
  // The disclosure gate (`verification-checks.ts`), each sent by `verification-checks-router.ts`'s own table.
  'support.verification_checks_required': 'PRECONDITION_FAILED',
  'support.verification_mismatch': 'BAD_REQUEST',
  'support.disclosure_unwired': 'PRECONDITION_FAILED',
  'support.verification_attempts_unset': 'PRECONDITION_FAILED',
  'support.verification_attempts_exhausted': 'TOO_MANY_REQUESTS',
  'support.read_grant_required': 'PRECONDITION_FAILED',
  'support.read_withdrawal_unlinked': 'PRECONDITION_FAILED',
} as const satisfies Record<string, RefusalStatus>;
type Code = keyof typeof STATUS;
const refuse = (...codes: Code[]): Refusals => Object.freeze(Object.fromEntries(codes.map((c) => [c, STATUS[c]])));

/** A move on a draft that must still be the newest version, and every refusal the review book gives a move. */
const REVIEW_MOVE = [
  'support.kb_draft_unknown',
  'support.kb_revision_stale',
  'support.kb_same_operator',
  'support.kb_not_in_review',
  'support.kb_not_approved',
  'support.kb_already_in_review',
] as const;
/** A limits reply lists each media type once (the stored list is written that way; JSON Schema cannot say it). */
const TYPES_ONCE = { typesOnce: { says: 'no media type is listed twice in allowedTypes', holds: supportAttachmentTypesDistinct } };
const FILES = [
  'support.not_found',
  'support.attachments_unconfigured',
  'support.attachment_scan_refused',
  'support.attachment_scan_unknown',
] as const;
const GATE = [
  'support.not_found',
  'support.ticket_closed',
  'support.read_grant_required',
  'support.read_withdrawal_unlinked',
  'support.disclosure_unwired',
] as const;

const base = { service: 'svc-support', module: 'support', transport: 'trpc' } as const;
const PUBLIC = { caller: 'public' } as const;
/** `support:ops` is the desk's interactive scope; no API key holds it. */
const DESK = { caller: 'scope', scope: 'support:ops' } as const;
const TICKET = '11111111-1111-4111-8111-111111111111';
const FILE = '22222222-2222-4222-8222-222222222222';

const articleRef = z.object({ id: supportKbLibraryIdSchema, revision: z.number().int().positive() }).strict();
const articleSamples = [
  { verdict: 'accept', input: { id: 'card-limits', revision: 2 } },
  { verdict: 'refuse', input: { id: 'card-limits', revision: 0 } },
] as const;

export const SUPPORT_KB_LIBRARY = defineProcedure({
  ...base,
  name: 'support.kbLibrary',
  kind: 'query',
  path: 'kbLibrary',
  access: PUBLIC,
  refusals: refuse(),
  input: NO_INPUT,
  output: supportKbLibrarySchema,
  samples: [{ verdict: 'accept' }],
});

export const SUPPORT_DESK_KB_TEMPLATES = defineProcedure({
  ...base,
  name: 'support.kbTemplates',
  kind: 'query',
  path: 'kbTemplates',
  access: DESK,
  refusals: refuse(),
  input: NO_INPUT,
  output: z.array(supportKbTemplateSchema),
  samples: [{ verdict: 'accept' }],
});

export const SUPPORT_DESK_KB_HISTORY = defineProcedure({
  ...base,
  name: 'support.kbHistory',
  kind: 'query',
  path: 'kbHistory',
  access: DESK,
  refusals: refuse(),
  input: z.object({ id: supportKbLibraryIdSchema }).strict(),
  output: supportKbHistorySchema,
  samples: [
    { verdict: 'accept', input: { id: 'card-limits' } },
    { verdict: 'refuse', input: { id: 'Card Limits' } },
  ],
});

export const SUPPORT_DESK_KB_DRAFT = defineProcedure({
  ...base,
  name: 'support.kbDraft',
  kind: 'query',
  path: 'kbDraft',
  access: DESK,
  refusals: refuse('support.kb_draft_unknown'),
  input: articleRef,
  output: supportKbDraftSchema,
  samples: articleSamples,
});

export const SUPPORT_DESK_KB_SAVE_DRAFT = defineProcedure({
  ...base,
  name: 'support.kbSaveDraft',
  kind: 'mutation',
  path: 'kbSaveDraft',
  access: DESK,
  refusals: refuse(
    'support.kb_title_blank',
    'support.kb_title_invalid',
    'support.kb_body_invalid',
    'support.kb_vendor_name',
    'support.kb_template_unknown',
    'support.kb_section_unknown',
    'support.kb_revision_stale',
  ),
  input: supportKbDraftSaveInputSchema,
  output: supportKbDraftSchema,
  samples: [
    {
      verdict: 'accept',
      input: { id: 'card-limits', title: 'Card limits', body: 'How limits work.', language: 'en', sectionId: 'cards', baseRevision: 0 },
    },
    { verdict: 'refuse', input: { id: 'card-limits', title: 'Card limits', body: 'How limits work.', language: 'en', sectionId: 'cards' } },
  ],
});

export const SUPPORT_DESK_KB_SUBMIT_FOR_REVIEW = defineProcedure({
  ...base,
  name: 'support.kbSubmitForReview',
  kind: 'mutation',
  path: 'kbSubmitForReview',
  access: DESK,
  refusals: refuse(...REVIEW_MOVE),
  input: articleRef,
  output: supportKbDraftSchema,
  samples: articleSamples,
});

export const SUPPORT_DESK_KB_APPROVE = defineProcedure({
  ...base,
  name: 'support.kbApprove',
  kind: 'mutation',
  path: 'kbApprove',
  access: DESK,
  refusals: refuse(...REVIEW_MOVE),
  input: articleRef,
  output: supportKbDraftSchema,
  samples: articleSamples,
});

export const SUPPORT_DESK_KB_SEND_BACK = defineProcedure({
  ...base,
  name: 'support.kbSendBack',
  kind: 'mutation',
  path: 'kbSendBack',
  access: DESK,
  refusals: refuse(...REVIEW_MOVE),
  input: supportKbReviewActInputSchema.required({ reason: true }),
  output: supportKbDraftSchema,
  samples: [
    { verdict: 'accept', input: { id: 'card-limits', revision: 2, reason: 'Name the fee.' } },
    { verdict: 'refuse', input: { id: 'card-limits', revision: 2 } },
  ],
});

export const SUPPORT_DESK_KB_PUBLISH_DRAFT = defineProcedure({
  ...base,
  name: 'support.kbPublishDraft',
  kind: 'mutation',
  path: 'kbPublishDraft',
  access: DESK,
  refusals: refuse(...REVIEW_MOVE, 'support.kb_section_unknown'),
  input: articleRef,
  output: supportKbArticleSchema,
  samples: articleSamples,
});

export const SUPPORT_DESK_KB_SAVE_TEMPLATE = defineProcedure({
  ...base,
  name: 'support.kbSaveTemplate',
  kind: 'mutation',
  path: 'kbSaveTemplate',
  access: DESK,
  refusals: refuse('support.kb_vendor_name', 'support.kb_template_revision_stale'),
  input: supportKbTemplateSaveInputSchema,
  output: supportKbTemplateSchema,
  samples: [
    { verdict: 'accept', input: { id: 'fees', name: 'Fees', body: 'What it costs.', expectedRevision: 0, reason: 'A first template.' } },
    { verdict: 'refuse', input: { id: 'fees', name: 'Fees', body: 'What it costs.', expectedRevision: 0 } },
  ],
});

export const SUPPORT_DESK_ATTACH_OPS = defineProcedure({
  ...base,
  name: 'support.attachOps',
  kind: 'mutation',
  path: 'attachOps',
  access: DESK,
  refusals: refuse(
    ...FILES,
    'support.attachment_body_invalid',
    'support.attachment_type_refused',
    'support.attachment_too_large',
    'support.attachment_count_unset',
    'support.attachment_count_reached',
    'support.client_request_id_required',
  ),
  input: z.object({
    ticketId: z.string().guid(),
    clientRequestId: z.string().min(1).max(200),
    contentType: z.string().min(1).max(200),
    bodyBase64: z.string(),
  }),
  output: supportAttachmentSchema,
  samples: [
    { verdict: 'accept', input: { ticketId: TICKET, clientRequestId: 'admin-attach:1', contentType: 'image/png', bodyBase64: 'aGk=' } },
    { verdict: 'refuse', input: { ticketId: TICKET, clientRequestId: '', contentType: 'image/png', bodyBase64: 'aGk=' } },
  ],
});

export const SUPPORT_DESK_ATTACHMENT_DOWNLOAD_OPS = defineProcedure({
  ...base,
  name: 'support.attachmentDownloadOps',
  kind: 'query',
  path: 'attachmentDownloadOps',
  access: DESK,
  refusals: refuse(...FILES),
  input: supportAttachmentIdInputSchema,
  output: supportAttachmentDownloadSchema,
  samples: [
    { verdict: 'accept', input: { attachmentId: FILE } },
    { verdict: 'refuse', input: { attachmentId: 'not-a-uuid' } },
  ],
});

export const SUPPORT_DESK_VERIFICATION_CHECKS = defineProcedure({
  ...base,
  name: 'support.verificationChecks',
  kind: 'query',
  path: 'verificationChecks',
  access: DESK,
  refusals: refuse('support.not_found'),
  input: supportTicketOnlyInputSchema,
  output: supportVerificationChecksSchema,
  samples: [
    { verdict: 'accept', input: { ticketId: TICKET } },
    { verdict: 'refuse', input: { ticketId: TICKET, userId: TICKET } },
  ],
});

export const SUPPORT_DESK_RECORD_VERIFICATION_CHECK = defineProcedure({
  ...base,
  name: 'support.recordVerificationCheck',
  kind: 'mutation',
  path: 'recordVerificationCheck',
  access: DESK,
  refusals: refuse(
    'support.not_found',
    'support.ticket_closed',
    'support.verification_mismatch',
    'support.verification_attempts_unset',
    'support.verification_attempts_exhausted',
    'support.disclosure_unwired',
  ),
  input: supportRecordVerificationCheckInputSchema,
  output: supportVerificationCheckSchema,
  samples: [
    { verdict: 'accept', input: { ticketId: TICKET, kind: 'client_order_id', value: 'order-1' } },
    { verdict: 'refuse', input: { ticketId: TICKET, kind: 'withdrawal_id', value: 'order-1' } },
  ],
});

/** A read under the customer's live grant (`support-read-grants.ts`): refused without one, and listed to the customer. */
export const SUPPORT_DESK_READ_DISCLOSURE = defineProcedure({
  ...base,
  name: 'support.readDisclosure',
  kind: 'query',
  path: 'readDisclosure',
  access: DESK,
  refusals: refuse(...GATE),
  input: supportDisclosureReadInputSchema,
  output: supportDisclosureSchema,
  samples: [
    { verdict: 'accept', input: { ticketId: TICKET, kind: 'balance' } },
    { verdict: 'refuse', input: { ticketId: TICKET, kind: 'password' } },
  ],
});

export const SUPPORT_DESK_ATTACHMENT_STATUS = defineProcedure({
  ...base,
  name: 'support.attachmentStatus',
  kind: 'query',
  path: 'attachmentStatus',
  access: DESK,
  refusals: refuse(),
  input: NO_INPUT,
  output: supportAttachmentStatusSchema,
  accept: TYPES_ONCE,
  samples: [{ verdict: 'accept' }],
});

export const SUPPORT_DESK_SET_ATTACHMENT_SETTINGS = defineProcedure({
  ...base,
  name: 'support.setAttachmentSettings',
  kind: 'mutation',
  path: 'setAttachmentSettings',
  access: DESK,
  refusals: refuse(),
  input: supportAttachmentSettingsSetInputSchema,
  output: supportAttachmentLimitsSchema,
  checks: {
    oneSetting: { at: 'input', says: 'at least one of maxBytes, allowedTypes and maxCount is given' },
    typesOnce: { at: 'input.allowedTypes', says: 'no media type is listed twice' },
    mediaType: {
      at: 'input.allowedTypes[]',
      says: 'each entry is a lower-case media type with no wildcard or parameter, such as image/png',
    },
  },
  accept: TYPES_ONCE,
  samples: [
    { verdict: 'accept', input: { maxCount: 5, expectedRevision: 0, reason: 'Five files a request.' } },
    { verdict: 'accept', input: { allowedTypes: ['image/png', 'application/pdf'], expectedRevision: 3, reason: 'Pictures and PDFs.' } },
    { verdict: 'refuse', input: { maxCount: 0, expectedRevision: 0, reason: 'Five files a request.' } },
    { verdict: 'refuse', by: 'oneSetting', input: { expectedRevision: 0, reason: 'Nothing changes.' } },
    { verdict: 'refuse', by: 'typesOnce', input: { allowedTypes: ['image/png', 'image/png'], expectedRevision: 0, reason: 'Twice.' } },
    { verdict: 'refuse', by: 'mediaType', input: { allowedTypes: ['image/*'], expectedRevision: 0, reason: 'Any picture.' } },
  ],
});

export const SUPPORT_CONTACT_CHANNELS = defineProcedure({
  ...base,
  name: 'support.contactChannels',
  kind: 'query',
  path: 'contactChannels',
  access: PUBLIC,
  refusals: refuse(),
  input: NO_INPUT,
  output: supportContactChannelsSchema,
  samples: [{ verdict: 'accept' }],
});

export const SUPPORT_DESK_SET_CONTACT_CHANNELS = defineProcedure({
  ...base,
  name: 'support.setContactChannels',
  kind: 'mutation',
  path: 'setContactChannels',
  access: DESK,
  refusals: refuse(),
  input: supportContactSetInputSchema,
  output: supportContactChannelsSchema,
  checks: {
    oneChannel: { at: 'input', says: 'at least one of email, phone and chatHours is given' },
    channelReads: {
      at: ['input.email', 'input.phone', 'input.chatHours'],
      says: 'a channel given as text is one email address, a phone number of at least five digits, or chat hours a visitor reads',
    },
  },
  samples: [
    { verdict: 'accept', input: { chatHours: 'Mon to Fri, 09:00 to 17:00 UTC', expectedRevision: 0, reason: 'Chat opens.' } },
    { verdict: 'accept', input: { email: null, expectedRevision: 2, reason: 'The address is retired.' } },
    { verdict: 'refuse', input: { chatHours: 'Mon to Fri', expectedRevision: -1, reason: 'Chat opens.' } },
    { verdict: 'refuse', by: 'oneChannel', input: { expectedRevision: 0, reason: 'Nothing changes.' } },
    { verdict: 'refuse', by: 'channelReads', input: { phone: '12', expectedRevision: 0, reason: 'A short number.' } },
  ],
});

export const SUPPORT_HELP_CENTRE = defineProcedure({
  ...base,
  name: 'support.helpCentre',
  kind: 'query',
  path: 'helpCentre',
  access: PUBLIC,
  refusals: refuse(),
  input: NO_INPUT,
  output: supportHelpCentreSchema,
  samples: [{ verdict: 'accept' }],
});

export const SUPPORT_DESK_HELP_CENTRE_TRANSLATIONS = defineProcedure({
  ...base,
  name: 'support.helpCentreTranslations',
  kind: 'query',
  path: 'helpCentreTranslations',
  access: DESK,
  refusals: refuse(),
  input: supportHelpCentreTranslationListInputSchema,
  output: supportHelpCentreTranslationListSchema,
  samples: [
    { verdict: 'accept', input: { limit: 100 } },
    { verdict: 'refuse', input: { limit: 0 } },
  ],
});

/** Every record this file holds, in the order the desk reads them. */
export const SUPPORT_DESK_SETTINGS_PROCEDURES = [
  SUPPORT_KB_LIBRARY,
  SUPPORT_DESK_KB_TEMPLATES,
  SUPPORT_DESK_KB_HISTORY,
  SUPPORT_DESK_KB_DRAFT,
  SUPPORT_DESK_KB_SAVE_DRAFT,
  SUPPORT_DESK_KB_SUBMIT_FOR_REVIEW,
  SUPPORT_DESK_KB_APPROVE,
  SUPPORT_DESK_KB_SEND_BACK,
  SUPPORT_DESK_KB_PUBLISH_DRAFT,
  SUPPORT_DESK_KB_SAVE_TEMPLATE,
  SUPPORT_DESK_ATTACH_OPS,
  SUPPORT_DESK_ATTACHMENT_DOWNLOAD_OPS,
  SUPPORT_DESK_VERIFICATION_CHECKS,
  SUPPORT_DESK_RECORD_VERIFICATION_CHECK,
  SUPPORT_DESK_READ_DISCLOSURE,
  SUPPORT_DESK_ATTACHMENT_STATUS,
  SUPPORT_DESK_SET_ATTACHMENT_SETTINGS,
  SUPPORT_CONTACT_CHANNELS,
  SUPPORT_DESK_SET_CONTACT_CHANNELS,
  SUPPORT_HELP_CENTRE,
  SUPPORT_DESK_HELP_CENTRE_TRANSLATIONS,
] as const;
