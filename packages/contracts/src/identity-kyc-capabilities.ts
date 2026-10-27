import { z } from 'zod';
import { kycLadderLevelSchema } from './identity-kyc-levels.js';
import { kycReasonCodeSchema } from './identity-kyc-cases.js';

/**
 * svc-identity `kyc.capabilities.get`, `kyc.capabilities.getFor` and `kyc.capabilities.set` (I-kyc-compliance-07): what a
 * person's verification lets them do, one row per capability. Approving a level makes the capabilities the owner maps
 * to it (`IDENTITY_KYC_CAPABILITIES_BY_LEVEL`, NO DEFAULT) active in the approval's own transaction; a request marks
 * them pending; a reject puts a pending one back to unrequested. `inactive` is terminal: compliance sets it with a
 * reason code and a four-eyes approval, and nothing turns it back on. With no mapping published, `mapped` is false and
 * an approval grants no capability, which the page says.
 */
export const KYC_CAPABILITIES = ['custody_crypto', 'custody_fiat', 'transfer_crypto', 'transfer_fiat', 'trade_crypto'] as const;
export const kycCapabilitySchema = z.enum(KYC_CAPABILITIES);
export type KycCapability = z.infer<typeof kycCapabilitySchema>;

export const KYC_CAPABILITY_STATES = ['unrequested', 'pending', 'active', 'inactive'] as const;
export const kycCapabilityStateSchema = z.enum(KYC_CAPABILITY_STATES);
export type KycCapabilityState = z.infer<typeof kycCapabilityStateSchema>;

export const kycCapabilityRowSchema = z.object({
  capability: kycCapabilitySchema,
  state: kycCapabilityStateSchema,
  /** The lowest level the owner maps this capability to, or null when no level grants it. */
  grantedAt: kycLadderLevelSchema.nullable(),
  /** Set on an inactive capability: the code from the owner's reason list. */
  reasonCode: kycReasonCodeSchema.nullable(),
  /** When the state last changed; null while it was never requested. */
  changedAt: z.string().datetime({ offset: true }).nullable(),
});
export type KycCapabilityRow = z.infer<typeof kycCapabilityRowSchema>;

export const kycCapabilitiesOutputSchema = z.object({
  /** False when the owner has published no level-to-capability mapping: an approval then grants none. */
  mapped: z.boolean(),
  capabilities: z.array(kycCapabilityRowSchema).length(KYC_CAPABILITIES.length),
});
export type KycCapabilitiesOutput = z.infer<typeof kycCapabilitiesOutputSchema>;
