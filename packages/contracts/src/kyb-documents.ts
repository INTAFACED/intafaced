import { z } from 'zod';
import { kybRequirementKeySchema } from './kyb-entity-types.js';

/**
 * Business verification (KYB) documents: the checklist for an application and the upload.
 *
 * Which documents a type needs is owner data (`kyb-entity-types.ts`). The size cap and the accepted content types are
 * owner data too (`pay.kyb_upload_rules`); a blank rule refuses the upload, nothing here supplies a number. The
 * automatic document check is an outside service: until it is connected the checklist says so and uploads still work.
 */
export const KYB_DOCUMENT_STATES = ['missing', 'provided', 'accepted', 'rejected'] as const;
export const kybDocumentStateSchema = z.enum(KYB_DOCUMENT_STATES);
export type KybDocumentState = z.infer<typeof kybDocumentStateSchema>;

const applicationIdSchema = z.string().guid();

export const kybDocumentSchema = z
  .object({
    id: z.string().guid(),
    contentType: z.string().min(1).max(128),
    byteLength: z.number().int().min(1),
    /** Lower-case hex SHA-256 of the bytes as stored. */
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    uploadedAt: z.string(),
  })
  .strict();
export type KybDocument = z.infer<typeof kybDocumentSchema>;

/** One required document. `document` is the latest upload for the key; `rejectionReason` is set only when rejected. */
export const kybDocumentRowSchema = z
  .object({
    key: kybRequirementKeySchema,
    state: kybDocumentStateSchema,
    rejectionReason: z.string().max(1000).nullable(),
    document: kybDocumentSchema.nullable(),
  })
  .strict();
export type KybDocumentRow = z.infer<typeof kybDocumentRowSchema>;

export const kybUploadRulesSchema = z
  .object({
    maxBytes: z.number().int().min(1),
    contentTypes: z.array(z.string().min(1).max(128)).min(1),
  })
  .strict();
export type KybUploadRules = z.infer<typeof kybUploadRulesSchema>;

/** The automatic check: `not_connected` names the outside service that is missing. */
export const kybDocumentVendorCheckSchema = z
  .object({ status: z.literal('not_connected'), notConnected: z.literal('vendor.kyc') })
  .strict();

export const kybDocumentChecklistViewSchema = z
  .object({
    applicationId: applicationIdSchema,
    /** Null while the owner has not published upload rules; uploads then refuse `pay.kyb_upload_rules_unset`. */
    uploadRules: kybUploadRulesSchema.nullable(),
    rows: z.array(kybDocumentRowSchema),
    vendorCheck: kybDocumentVendorCheckSchema,
  })
  .strict();
export type KybDocumentChecklistView = z.infer<typeof kybDocumentChecklistViewSchema>;

export const kybDocumentsChecklistInputSchema = z.object({ applicationId: applicationIdSchema }).strict();

export const kybDocumentsUploadInputSchema = z
  .object({
    applicationId: applicationIdSchema,
    key: kybRequirementKeySchema,
    contentType: z.string().trim().min(1).max(128),
    /** Base64 bytes. The owner's size cap is applied to the decoded size; this bound only stops absurd bodies. */
    bytesBase64: z.string().min(1).max(40_000_000),
  })
  .strict();

/** The checklist row for the uploaded key. The same bytes for the same key again return the same document. */
export const kybDocumentsUploadResultSchema = z.object({ row: kybDocumentRowSchema }).strict();

// ---- compliance review (J-merchant-02 step 3) -------------------------------------------------------------------

/** A compliance reviewer's verdict on one upload: accepted reads Verified to the business, rejected reads Invalid. */
export const KYB_DOCUMENT_VERDICTS = ['accepted', 'rejected'] as const;
export const kybDocumentVerdictSchema = z.enum(KYB_DOCUMENT_VERDICTS);
export type KybDocumentVerdict = z.infer<typeof kybDocumentVerdictSchema>;

/**
 * Review the upload `documentId`, which must still be its key's current upload. A rejection carries the reason the
 * business reads; an acceptance carries none. A verdict is final for that upload: the business sends a new file.
 */
export const kybDocumentReviewInputSchema = z
  .object({
    applicationId: applicationIdSchema,
    documentId: z.string().guid(),
    verdict: kybDocumentVerdictSchema,
    reason: z.string().trim().min(3).max(1000).nullish(),
  })
  .strict()
  .refine((input) => (input.verdict === 'rejected') === Boolean(input.reason), {
    message: 'a rejection needs a reason, and an acceptance takes none',
    path: ['reason'],
  });
export type KybDocumentReviewInput = z.infer<typeof kybDocumentReviewInputSchema>;

/** A checklist row as the reviewer sees it: who gave the verdict and when, null while it waits. */
export const kybDocumentReviewRowSchema = kybDocumentRowSchema
  .extend({ reviewedBy: z.string().max(128).nullable(), reviewedAt: z.string().nullable() })
  .strict();
export type KybDocumentReviewRow = z.infer<typeof kybDocumentReviewRowSchema>;

/** One merchant's current application and its documents, for compliance. `application` is null when none was started. */
export const kybDocumentReviewViewSchema = z
  .object({
    merchantId: z.string().guid(),
    application: z
      .object({
        applicationId: applicationIdSchema,
        entityType: z.string().min(1).max(64),
        country: z.string().length(2),
        state: z.enum(['draft', 'submitted']),
        submittedAt: z.string().nullable(),
      })
      .strict()
      .nullable(),
    rows: z.array(kybDocumentReviewRowSchema),
    vendorCheck: kybDocumentVendorCheckSchema,
  })
  .strict();
export type KybDocumentReviewView = z.infer<typeof kybDocumentReviewViewSchema>;

export const kybDocumentReviewViewInputSchema = z.object({ merchantId: z.string().guid() }).strict();

/** The bytes of one upload, decrypted for a compliance reviewer. Each read is recorded. */
export const kybDocumentFileInputSchema = z.object({ applicationId: applicationIdSchema, documentId: z.string().guid() }).strict();
export const kybDocumentFileSchema = z
  .object({
    documentId: z.string().guid(),
    key: kybRequirementKeySchema,
    contentType: z.string().min(1).max(128),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    bytesBase64: z.string().min(1),
  })
  .strict();
export type KybDocumentFile = z.infer<typeof kybDocumentFileSchema>;
