import { z } from 'zod';
import { kycProfileUploadCapsSchema } from './identity-kyc-profile.js';

/**
 * svc-identity proof of address (I-kyc-compliance-11, J-identity-08 #5). Asked for once level Basic is approved. The
 * owner publishes which documents count per country, and which never do (screenshots, mobile phone bills, letters),
 * and how recent one must be (`IDENTITY_KYC_POA_MAX_AGE_DAYS`, NO DEFAULT: unset refuses `kyc.poa_rule_unset`). The
 * person enters the date it was issued; older than the rule refuses `kyc.poa_too_old`. A document from a country other
 * than the one on the approved level is sent with a flag for the reviewer. The file goes to the encrypted vault.
 */
const alpha2 = z.string().regex(/^[A-Z]{2}$/);
const typeCode = z.string().regex(/^[a-z][a-z0-9_]{1,63}$/);
const listed = z.object({ type: typeCode, label: z.string().min(1).max(120) });

export const kycPoaSubmissionSchema = z.object({
  id: z.string().uuid(),
  type: typeCode,
  /** The owner's label for the type in the document's own country; null when that list no longer has it. */
  label: z.string().min(1).max(120).nullable(),
  country: alpha2,
  issuedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  status: z.enum(['submitted', 'accepted', 'rejected']),
  /** Set when the document's country differs from the residence on the approved level: the reviewer checks it. */
  countryMismatch: z.boolean(),
  createdAt: z.string().datetime({ offset: true }),
});
export type KycPoaSubmission = z.infer<typeof kycPoaSubmissionSchema>;

export const kycPoaReadInputSchema = z.object({ country: alpha2.optional() }).strict();
export const kycPoaReadSchema = z.object({
  /** False until level Basic (or higher) is approved: the step is asked for after it. */
  requested: z.boolean(),
  /** The country on the approved level, which the document is compared with. */
  residence: alpha2.nullable(),
  /** The owner's recency rule; null when unset, and then a submission refuses. */
  maxAgeDays: z.number().int().min(1).nullable(),
  /** The lists for `country` (or the residence): `published: false` when the owner set none for it. */
  documents: z.object({
    country: alpha2.nullable(),
    published: z.boolean(),
    accepted: z.array(listed),
    rejected: z.array(listed),
  }),
  latest: kycPoaSubmissionSchema.nullable(),
  /** The owner's file caps, shared with the ID photo; null when unset, and then a submission refuses. */
  uploadCaps: kycProfileUploadCapsSchema.nullable(),
});
export type KycPoaRead = z.infer<typeof kycPoaReadSchema>;

export const kycPoaSubmitInputSchema = z
  .object({
    type: typeCode,
    country: alpha2,
    issuedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    contentType: z.string().min(1).max(128),
    /** Base64 bytes; the owner's photo caps (I-kyc-compliance-08) apply to the decoded length. */
    bytesBase64: z.string().min(1).max(14_000_000),
  })
  .strict();
