import { z } from 'zod';
import { kycProfileUploadCapsSchema } from './identity-kyc-profile.js';

/**
 * svc-identity selfie (I-kyc-compliance-09, J-identity-08 #3). The person takes a live selfie with the camera on this
 * device, or on their phone through a one-time hand-off link. The automatic face match and liveness check
 * (`vendor.kyc`) are not connected, so every selfie is kept, encrypted in the vault, for a person to compare with the
 * ID photo. The hand-off link lasts the owner's `IDENTITY_KYC_HANDOFF_TTL_SECONDS` (NO DEFAULT: unset refuses
 * `kyc.handoff_unset`), works once, and only for the account that made it.
 */
const handoffToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const actionName = z.string().regex(/^[a-z][a-z0-9_.]{1,63}$/);

export const kycSelfieSchema = z.object({
  id: z.string().uuid(),
  /** `provided` waits for a person to compare it with the ID photo. */
  status: z.enum(['provided', 'accepted', 'rejected']),
  /** Taken on this device, or on a phone through a hand-off link. */
  via: z.enum(['this_device', 'handoff']),
  createdAt: z.string().datetime({ offset: true }),
});
export type KycSelfie = z.infer<typeof kycSelfieSchema>;

/**
 * Compliance's view (`kyc.selfie.listFor`, `kyc.selfie.decide`): the vault id of the frame, opened through
 * `kyc.getDocument`, to compare with the ID photo. `captureCheck` says the server did not check that the frame was live:
 * the page takes it from the camera, and `via` is what the device reported.
 */
export const kycSelfieForComplianceSchema = kycSelfieSchema.extend({
  documentId: z.string().uuid(),
  captureCheck: z.literal('not_checked'),
  decidedAt: z.string().datetime({ offset: true }).nullable(),
});
export type KycSelfieForCompliance = z.infer<typeof kycSelfieForComplianceSchema>;

export const kycSelfieDecisionSchema = z.enum(['accepted', 'rejected']);
export type KycSelfieDecision = z.infer<typeof kycSelfieDecisionSchema>;

export const kycSelfieDecideInputSchema = z
  .object({
    selfieId: z.string().uuid(),
    decision: kycSelfieDecisionSchema,
    approvalId: z.string().max(128).nullish(),
    operationId: z.string().max(128).nullish(),
  })
  .strict();

export const kycSelfieReadSchema = z.object({
  latest: kycSelfieSchema.nullable(),
  /** The automatic face match: not connected, so a person compares. */
  faceCheck: z.literal('not_connected'),
  liveness: z.object({
    check: z.literal('not_connected'),
    /** The owner's actions that ask for a liveness re-check (`IDENTITY_KYC_LIVENESS_RECHECK_FOR`); null when none is set. */
    recheckFor: z.array(actionName).nullable(),
  }),
  /** How long a hand-off link lasts; null when the owner has not set it, and then a hand-off refuses. */
  handoffTtlSeconds: z.number().int().positive().nullable(),
  /** The owner's file caps, shared with the ID photo; null when unset, and then a selfie refuses. */
  uploadCaps: kycProfileUploadCapsSchema.nullable(),
});
export type KycSelfieRead = z.infer<typeof kycSelfieReadSchema>;

export const kycSelfieSubmitInputSchema = z
  .object({
    contentType: z.string().min(1).max(128),
    /** Base64 bytes of the captured frame; the owner's photo caps apply to the decoded length. */
    bytesBase64: z.string().min(1).max(14_000_000),
    /** Present when the selfie is taken on a phone through a hand-off link. */
    handoff: handoffToken.optional(),
  })
  .strict();

export const kycSelfieHandoffSchema = z.object({
  token: handoffToken,
  expiresAt: z.string().datetime({ offset: true }),
});
export type KycSelfieHandoff = z.infer<typeof kycSelfieHandoffSchema>;

export const kycSelfieHandoffCheckInputSchema = z.object({ token: handoffToken }).strict();
export const kycSelfieHandoffCheckSchema = z.object({
  state: z.enum(['open', 'used', 'expired']),
  expiresAt: z.string().datetime({ offset: true }),
});
export type KycSelfieHandoffCheck = z.infer<typeof kycSelfieHandoffCheckSchema>;
