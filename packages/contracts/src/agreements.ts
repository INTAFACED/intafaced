/**
 * Legal agreements register held by svc-identity (RC-identity-12, TRD-0631).
 * A service that needs an acceptance calls `agreements.requires` and refuses `<service>.agreement_required` itself;
 * a missing acceptance never blocks a closing or reducing action.
 */
import { z } from 'zod';

export const AGREEMENT_KINDS = [
  'trading',
  'custody',
  'margin',
  'market_data',
  'api',
  'rfq_block',
  'broker',
  'off_exchange_settlement',
] as const;
export const agreementKindSchema = z.enum(AGREEMENT_KINDS);
export type AgreementKind = z.infer<typeof agreementKindSchema>;

/** Four-eyes action type (and target id) for publishing a new agreement version. */
export const AGREEMENT_PUBLISH_ACTION = 'identity.agreement_publish';

export const agreementRequiresInputSchema = z.object({ subjectId: z.string().uuid(), kind: agreementKindSchema }).strict();
export const agreementRequiresOutputSchema = z.object({
  kind: agreementKindSchema,
  /** Null when no version of this kind is published: nothing can be required yet. */
  currentVersion: z.number().int().positive().nullable(),
  acceptedVersion: z.number().int().positive().nullable(),
  required: z.boolean(),
});
export type AgreementRequiresOutput = z.infer<typeof agreementRequiresOutputSchema>;
