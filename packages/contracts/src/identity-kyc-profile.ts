import { z } from 'zod';

/**
 * svc-identity guided verification (I-kyc-compliance-08, J-identity-08 #2). A person fills six steps; each save keeps
 * the draft, so leaving and coming back resumes at the step left with what was entered. The fields are personal data:
 * identity keeps them encrypted under the KYC document key and never in `kyc_records`. The ID photo goes to the
 * encrypted document vault, under the owner's size and type caps (unset refuses). Sending opens the verification
 * request; with the automatic document check not connected (`vendor.kyc`) a person reviews it in our own queue.
 */
const submittableKycTierSchema = z.enum(['basic', 'full', 'institutional']);

export const KYC_PROFILE_STEPS = ['residence', 'identity', 'document', 'address', 'upload', 'review'] as const;
export type KycProfileStep = (typeof KYC_PROFILE_STEPS)[number];
/** Steps are numbered from 1 as the page shows them. */
export const kycProfileStepNumberSchema = z.number().int().min(1).max(KYC_PROFILE_STEPS.length);

const alpha2 = z.string().regex(/^[A-Z]{2}$/);
const text = (max: number) => z.string().trim().min(1).max(max);
/** A real calendar date, not in the future and not before 1900. */
const dateOfBirth = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const at = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(at.getTime()) && at.toISOString().slice(0, 10) === value && value >= '1900-01-01' && at.getTime() <= Date.now();
  }, 'not a valid date of birth');
export const kycDocumentTypeCodeSchema = z.string().regex(/^[a-z][a-z0-9_]{1,63}$/);

/** Everything a draft holds. Null is not entered yet. */
export const kycProfileFieldsSchema = z
  .object({
    residence: alpha2.nullable(),
    nationality: alpha2.nullable(),
    legalName: text(200).nullable(),
    /** Optional: the legal name in the local script. */
    localName: text(200).nullable(),
    dateOfBirth: dateOfBirth.nullable(),
    documentType: kycDocumentTypeCodeSchema.nullable(),
    documentNumber: text(64).nullable(),
    addressLine: text(200).nullable(),
    city: text(100).nullable(),
    postalCode: text(20).nullable(),
    /** Set by the upload step: the vault's opaque id for the ID photo. */
    documentId: z.string().uuid().nullable(),
  })
  .strict();
export type KycProfileFields = z.infer<typeof kycProfileFieldsSchema>;

/** What each step asks for (the upload step takes a file, the review step sends). */
export const kycProfileStepFieldsSchemas = {
  residence: z.object({ residence: alpha2, nationality: alpha2 }).strict(),
  identity: z.object({ legalName: text(200), localName: text(200).nullable(), dateOfBirth }).strict(),
  document: z.object({ documentType: kycDocumentTypeCodeSchema, documentNumber: text(64) }).strict(),
  address: z.object({ addressLine: text(200), city: text(100), postalCode: text(20) }).strict(),
} as const;
export type KycProfileFieldStep = keyof typeof kycProfileStepFieldsSchemas;

export const kycProfileUploadCapsSchema = z.object({
  maxBytes: z.number().int().min(1),
  contentTypes: z.array(z.string().min(1).max(128)).min(1),
});
export type KycProfileUploadCaps = z.infer<typeof kycProfileUploadCapsSchema>;

export const kycProfileDraftSchema = z.object({
  tier: submittableKycTierSchema,
  /** The step to resume at. */
  step: kycProfileStepNumberSchema,
  version: z.number().int().min(1),
  fields: kycProfileFieldsSchema,
  /** Set once sent: the verification request it opened. */
  recordId: z.string().uuid().nullable(),
  updatedAt: z.string().datetime({ offset: true }),
});
export type KycProfileDraft = z.infer<typeof kycProfileDraftSchema>;

export const kycProfileSchema = z.object({
  draft: kycProfileDraftSchema.nullable(),
  /** A saved draft the current key cannot open: it reads as none, and starting again replaces it. */
  unreadableDraft: z.boolean(),
  /** The owner's caps on the ID photo; null when unset, and then an upload refuses. */
  uploadCaps: kycProfileUploadCapsSchema.nullable(),
  /** The automatic document check: not connected sends every request to a person for review. */
  documentCheck: z.enum(['connected', 'not_connected']),
});
export type KycProfile = z.infer<typeof kycProfileSchema>;

export const kycProfileStartInputSchema = z.object({ tier: submittableKycTierSchema }).strict();
export const kycProfileSaveStepInputSchema = z
  .object({
    step: z.enum(['residence', 'identity', 'document', 'address']),
    /** The draft version this save was made from; a stale one refuses `kyc.profile_version`. */
    version: z.number().int().min(1),
    fields: z.record(z.string(), z.unknown()),
  })
  .strict();
export const kycProfileUploadInputSchema = z
  .object({
    version: z.number().int().min(1),
    contentType: z.string().min(1).max(128),
    /** Base64 bytes; the owner's cap applies to the decoded length. */
    bytesBase64: z.string().min(1).max(14_000_000),
  })
  .strict();
export const kycProfileSubmitInputSchema = z.object({ version: z.number().int().min(1) }).strict();

export const kycDocumentTypesInputSchema = z.object({ country: alpha2 }).strict();
export const kycDocumentTypesSchema = z.object({
  country: alpha2,
  /** False when the owner published no list for this country: "not published", never an empty list. */
  published: z.boolean(),
  types: z.array(z.object({ type: kycDocumentTypeCodeSchema, label: z.string().min(1).max(120), originalRequired: z.boolean() })),
});
export type KycDocumentTypes = z.infer<typeof kycDocumentTypesSchema>;
