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
