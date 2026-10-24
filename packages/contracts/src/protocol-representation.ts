import { z } from 'zod';

/**
 * Wire types for the first-signing representation (D-developer-compliance-03): `protocol.representation.status` and
 * `protocol.representation.accept`. Public on the Protocol plane (a visitor may be signed out); what authorises an
 * accept is the wallet's own signature over `message`, verified by svc-protocol.
 */
export const PROTOCOL_REPRESENTATION_REFUSALS = [
  'compliance.representation_unset',
  'compliance.representation_version_stale',
  'compliance.representation_signature_not_owner',
] as const;
export type ProtocolRepresentationRefusal = (typeof PROTOCOL_REPRESENTATION_REFUSALS)[number];

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

export const protocolRepresentationStatusInputSchema = z.object({ address });

export const protocolRepresentationStatusOutputSchema = z.object({
  version: z.string().min(1),
  text: z.string().min(1),
  /** The exact message the wallet signs to accept this version. */
  message: z.string().min(1),
  accepted: z.boolean(),
  /** ISO time the acceptance of this version was recorded; null when not accepted. */
  acceptedAt: z.string().datetime().nullable(),
});
export type ProtocolRepresentationStatus = z.infer<typeof protocolRepresentationStatusOutputSchema>;

export const protocolRepresentationAcceptInputSchema = z.object({
  address,
  version: z.string().min(1).max(64),
  // A 65-byte signature, or its 64-byte compact form (EIP-2098).
  signature: z.string().regex(/^0x(?:[0-9a-fA-F]{128}|[0-9a-fA-F]{130})$/),
});

export const protocolRepresentationAcceptOutputSchema = z.object({
  address,
  version: z.string().min(1),
  acceptedAt: z.string().datetime(),
});
export type ProtocolRepresentationAccept = z.infer<typeof protocolRepresentationAcceptOutputSchema>;
