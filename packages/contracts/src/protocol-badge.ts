import { z } from 'zod';

/**
 * Wire types for the founding badge (RC-more-catalogue-04): `protocol.badge.eligibility` and `protocol.badge.claim`.
 *
 * Neither input carries an account or an address: the account is the signed principal and the address is that
 * account's own registered smart account, resolved server side. `audited` is the literal `false`.
 */
export const PROTOCOL_BADGE_REFUSALS = [
  'badge.window_unset',
  'badge.not_eligible',
  'badge.already_claimed',
  'audit.external',
  'rail.crypto',
] as const;
export type ProtocolBadgeRefusal = (typeof PROTOCOL_BADGE_REFUSALS)[number];

export const protocolBadgeEligibilityOutputSchema = z.object({
  eligible: z.boolean(),
  claimed: z.boolean(),
  label: z.enum(['TEST', 'MAINNET']),
  audited: z.literal(false),
  txHash: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/)
    .nullable(),
});
export type ProtocolBadgeEligibility = z.infer<typeof protocolBadgeEligibilityOutputSchema>;

export const protocolBadgeClaimOutputSchema = z.object({
  key: z.string().min(1),
  chainId: z.number().int().positive(),
  to: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  txHash: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/)
    .nullable(),
  label: z.literal('TEST'),
  audited: z.literal(false),
});
export type ProtocolBadgeClaim = z.infer<typeof protocolBadgeClaimOutputSchema>;
