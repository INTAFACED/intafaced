/**
 * Contract ownership proof for a token listing (D-launch-listing-01), svc-protocol `listing.ownershipChallenge` and
 * `listing.verifyOwnership`. The challenge is a one-time message the token's owner signs; the proof records the owner that
 * signed and the block its ownership was read at. Public like the rest of the Protocol Plane: the visitor may be signed out.
 */
import { z } from 'zod';

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 20-byte hex address');

export const protocolListingChallengeInputSchema = z.object({ token: address }).strict();
export const protocolListingChallengeOutputSchema = z
  .object({
    nonce: z.string(),
    token: z.string(),
    chainId: z.number().int(),
    /** The exact text to sign. */
    message: z.string(),
    issuedAt: z.string(),
    expiresAt: z.string(),
  })
  .strict();

export const protocolListingVerifyInputSchema = z
  .object({
    nonce: z.string().regex(/^[0-9a-f]{32}$/),
    signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
  })
  .strict();
export const protocolListingVerifyOutputSchema = z
  .object({
    token: z.string(),
    signer: z.string(),
    /** Decimal string: the block the owner was read at. */
    blockNumber: z.string(),
    verifiedAt: z.string(),
  })
  .strict();

export type ProtocolListingChallenge = z.infer<typeof protocolListingChallengeOutputSchema>;
export type ProtocolListingProof = z.infer<typeof protocolListingVerifyOutputSchema>;
