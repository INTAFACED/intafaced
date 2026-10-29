import { kycSelfieForComplianceSchema, type KycSelfieForCompliance } from '@intafaced/contracts/identity-kyc-selfie';

/**
 * Reads identity's answer to `kyc.selfie.decide` (I-kyc-compliance-09) with the contract's own schema, so the console accepts
 * exactly what identity promises to send. Pure; the server reads the answer with it before the run reports success.
 */
export function readSelfie(raw: unknown): KycSelfieForCompliance | null {
  const parsed = kycSelfieForComplianceSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
