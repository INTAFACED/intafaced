import { z } from 'zod';

/**
 * Wire types for the embedded self-custody wallet (J-wallet-22), version 1: svc-protocol's `embeddedWallet.*`, signed in.
 *
 * A person gets their own wallet with a passkey and no seed phrase (OWNER 237). The key is made and kept by the owner's
 * embedded-wallet provider and signs only after the person's own passkey; INTAFACED's record holds the address and the
 * provider's wallet id, never key material. The record has no key field, and the provider is reached through one
 * adapter behind a provider interface, so the provider the owner picks plugs in as one adapter. Export and recovery are
 * the person's own, at the provider. A labelled TEST provider stands in on test stacks only.
 */
export const PROTOCOL_EMBEDDED_WALLET_CONTRACT_VERSION = 1 as const;

export const PROTOCOL_EMBEDDED_WALLET_REFUSALS = [
  /** The owner's embedded-wallet provider setting is blank, so no wallet can be made. Nothing was made. */
  'wallet.embedded_provider_unset',
  /** The setting names a provider this build has no adapter for yet. Nothing was made. */
  'wallet.embedded_provider_unwired',
  /** The provider did not answer, or answered with an error. The message names the provider. Nothing was made. */
  'wallet.embedded_provider_down',
  /** The provider says the wallet belongs to someone else, or the passkey it was given is malformed. Nothing was recorded. */
  'wallet.embedded_wallet_mismatch',
] as const;
export type ProtocolEmbeddedWalletRefusal = (typeof PROTOCOL_EMBEDDED_WALLET_REFUSALS)[number];

/** The provider adapters this build knows by id. `test` is the labelled TEST provider (test stacks only). */
export const EMBEDDED_WALLET_PROVIDER_IDS = ['test', 'privy', 'turnkey'] as const;
export type EmbeddedWalletProviderId = (typeof EMBEDDED_WALLET_PROVIDER_IDS)[number];

/** The base64url shape WebAuthn ids and keys travel in. */
const base64url = z.string().regex(/^[A-Za-z0-9_-]+$/);

/**
 * The person's passkey as the provider needs it to let only that passkey sign: its credential id and its PUBLIC key
 * (SubjectPublicKeyInfo, ES256). Neither can sign anything. svc-protocol passes it to the provider and keeps neither.
 */
export const embeddedWalletPasskeySchema = z.object({
  credentialId: base64url.max(1400),
  publicKey: base64url.max(400),
  /** COSE algorithm. ES256 (-7) only. */
  algorithm: z.literal(-7),
});
export type EmbeddedWalletPasskey = z.infer<typeof embeddedWalletPasskeySchema>;

export const protocolEmbeddedWalletProviderSchema = z.object({
  id: z.enum(EMBEDDED_WALLET_PROVIDER_IDS),
  /** The name the room shows for where the key is kept: the adapter's configured display name, never a hard-coded vendor. */
  displayName: z.string(),
  /** True for the labelled TEST provider: every wallet it makes is TEST. */
  test: z.boolean(),
  /** What the provider itself offers the person. A false one is said in words, never a button that fails. */
  capabilities: z.object({ export: z.boolean(), recovery: z.boolean() }),
});
export type ProtocolEmbeddedWalletProvider = z.infer<typeof protocolEmbeddedWalletProviderSchema>;

export const protocolEmbeddedWalletRecordSchema = z.object({
  /** Checksummed EVM address on the venue's network. */
  address: z.string(),
  /** The provider's own id for the wallet. */
  providerWalletId: z.string(),
  provider: z.enum(EMBEDDED_WALLET_PROVIDER_IDS),
  /** The business key the wallet was made under: `wallet:embedded:<personId>`. */
  idempotencyKey: z.string(),
  createdAt: z.string(),
  test: z.boolean(),
  /** Always false: INTAFACED holds no key material for the wallet. */
  holdsKey: z.literal(false),
});
export type ProtocolEmbeddedWalletRecord = z.infer<typeof protocolEmbeddedWalletRecordSchema>;

export const protocolEmbeddedWalletStatusOutputSchema = z.object({
  /** Null while the owner's provider setting is blank: creating refuses `wallet.embedded_provider_unset`. */
  provider: protocolEmbeddedWalletProviderSchema.nullable(),
  /** The person's one wallet, or null when they have none yet. */
  wallet: protocolEmbeddedWalletRecordSchema.nullable(),
});
export type ProtocolEmbeddedWalletStatus = z.infer<typeof protocolEmbeddedWalletStatusOutputSchema>;

export const protocolEmbeddedWalletCreateInputSchema = z.object({ passkey: embeddedWalletPasskeySchema });
export const protocolEmbeddedWalletCreateOutputSchema = z.object({
  wallet: protocolEmbeddedWalletRecordSchema,
  /** False when the person already had a wallet: the same one comes back, never a second. */
  created: z.boolean(),
});

/** The business key one person's embedded wallet is made under. One per person, ever. */
export const embeddedWalletKey = (personId: string) => `wallet:embedded:${personId}`;
