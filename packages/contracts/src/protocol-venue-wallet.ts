import { z } from 'zod';

/**
 * Wire types for the venue wallet connection (J-wallet-09), version 1: svc-protocol's `venueWallet.*`, signed in.
 *
 * A signed-in person connects their own wallet to their INTAFACED account so a venue account the wallet owns can be
 * funded and traded from it. The connection is a record of an address and its expiry, proven by the wallet's own
 * EIP-4361 signature. INTAFACED holds no key that can move the wallet's funds: the record has no key field, and every
 * venue action is signed in the wallet. An expired connection refuses every signed action until the wallet signs again.
 */
export const PROTOCOL_VENUE_WALLET_CONTRACT_VERSION = 1 as const;

export const PROTOCOL_VENUE_WALLET_REFUSALS = [
  /** The session secret or the origins wallet messages are written for are blank (owner settings, shared with the wallet session). */
  'protocol.wallet_session_unset',
  /** The page asked for a message for an origin the owner has not listed. */
  'protocol.wallet_session_origin_unlisted',
  /** The owner has not published how long a venue wallet connection lasts. */
  'protocol.venue_connection_ttl_unset',
  /** The owner has not published the wallet sanctions list, so no wallet can be screened or connected. */
  'protocol.wallet_sanctions_unset',
  /** The wallet is on the owner's wallet sanctions list. */
  'protocol.wallet_sanctioned',
  /** The challenge was not written by this service for this person, is for another chain, or has expired. */
  'protocol.wallet_challenge_invalid',
  /** The signature does not recover to the address the challenge was written for. */
  'protocol.wallet_signature_not_owner',
  /** This challenge was already signed and used once: a connection is a new signature. */
  'protocol.venue_challenge_used',
  /** This wallet is not connected to this account (never connected, or disconnected). */
  'protocol.venue_connection_none',
  /** The connection's expiry has passed: every signed action refuses until the wallet signs again. */
  'protocol.venue_connection_expired',
  /** No venue is wired to this stack yet, so nothing was asked of the wallet. */
  'protocol.venue_unwired',
] as const;
export type ProtocolVenueWalletRefusal = (typeof PROTOCOL_VENUE_WALLET_REFUSALS)[number];

/** The venue actions a live connection is checked for before the wallet is asked to sign. */
export const VENUE_WALLET_ACTIONS = ['deposit', 'withdraw'] as const;
export type VenueWalletAction = (typeof VENUE_WALLET_ACTIONS)[number];

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

export const protocolVenueWalletChallengeInputSchema = z.object({ address, origin: z.string().max(200) });
export const protocolVenueWalletChallengeOutputSchema = z.object({
  /** The exact EIP-4361 message the wallet signs: INTAFACED, the address, the chain, a nonce and the expiry. */
  message: z.string(),
  /** Sealed by the service; handed back with the signature. */
  challenge: z.string(),
  /** When the connection made from this message ends: the same time the message states. */
  expiresAt: z.string(),
});
export const protocolVenueWalletOpenInputSchema = z.object({ challenge: z.string().max(4000), signature: z.string().max(400) });

export const protocolVenueWalletConnectionSchema = z.object({
  address: z.string(),
  chainId: z.number().int(),
  connectedAt: z.string(),
  expiresAt: z.string(),
  /** `live` until `expiresAt`; `expired` after it. A disconnected wallet is not listed. */
  status: z.enum(['live', 'expired']),
  /** Always false: the connection stores an address, never a key that can move the wallet's funds. */
  holdsKey: z.literal(false),
});
export const protocolVenueWalletStatusOutputSchema = z.object({
  connections: z.array(protocolVenueWalletConnectionSchema),
});
export const protocolVenueWalletAddressInputSchema = z.object({ address });
export const protocolVenueWalletDisconnectedOutputSchema = z.object({ address: z.string(), disconnected: z.literal(true) });
export const protocolVenueWalletAuthorizeInputSchema = z.object({ address, action: z.enum(VENUE_WALLET_ACTIONS) });

export type ProtocolVenueWalletConnection = z.infer<typeof protocolVenueWalletConnectionSchema>;
