import { z } from 'zod';

/**
 * Wire types for wallet orders on the Protocol plane (D-limit-dca-01 to -04), version 1: svc-dex's `auth.*` order
 * session and the order vault's orders. The person may be signed out of INTAFACED: what proves they own the orders is a
 * signature from the wallet itself. `auth.challenge` writes an EIP-712 order session (its scope, expiry and the order cap
 * schedule, all shown before the wallet is asked), `auth.verify` checks the wallet signed it and spends its nonce once,
 * and every order call carries the access token it returns. The service reads the maker from the token it issued, never
 * from an address the caller names. Every call is a POST (a tRPC mutation), reads included, so a token travels in a
 * body and never in a URL an access log keeps.
 */
export const PROTOCOL_DEX_ORDERS_CONTRACT_VERSION = 1 as const;

export const DEX_AUTH_REFUSALS = [
  /** The session secret is blank (owner setting): no order session can be written. */
  'dex.auth.session_unset',
  /** The access or refresh lifetime is blank (owner setting). */
  'dex.auth.lifetime_unset',
  /** The challenge was not written by this service, is for another chain or wallet, or has expired. */
  'dex.auth.challenge_invalid',
  /** The challenge was already spent: a signature is good for one session only. */
  'dex.auth.challenge_replayed',
  /** The signature does not recover to the wallet the challenge was written for. */
  'dex.auth.signature_not_owner',
  /** The access or refresh token is missing, altered, expired or revoked: sign a new order session. */
  'dex.auth.unauthenticated',
  /** The token is good but does not reach what was asked (another wallet's order). */
  'dex.auth.forbidden',
] as const;
export type DexAuthRefusal = (typeof DEX_AUTH_REFUSALS)[number];

export const DEX_ORDER_CAP_REFUSALS = [
  /** The order cap schedule is blank (owner setting): no session is written, so no order can be placed. */
  'dex.order.cap_unset',
] as const;

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const decimal = z.string().regex(/^\d+(\.\d+)?$/);

/** One row of the owner's order cap schedule: the most one session may keep open in orders that sell this token. */
export const dexOrderCapSchema = z.object({ token: address, symbol: z.string().min(1), max: decimal });
export type DexOrderCap = z.infer<typeof dexOrderCapSchema>;

/** The EIP-712 document the wallet signs: the same shape the wallet's `eth_signTypedData_v4` takes. */
export const dexTypedDataSchema = z.object({
  types: z.record(z.string(), z.array(z.object({ name: z.string(), type: z.string() }))),
  primaryType: z.string(),
  domain: z.object({ name: z.string(), version: z.string(), chainId: z.number().int() }),
  message: z.record(z.string(), z.unknown()),
});
export type DexTypedData = z.infer<typeof dexTypedDataSchema>;

export const dexAuthChallengeInputSchema = z.object({ address, chainId: z.number().int().positive() });
export const dexAuthChallengeOutputSchema = z.object({
  /** Sealed by the service; handed back with the signature. Not a session. */
  challenge: z.string(),
  typedData: dexTypedDataSchema,
  /** What the signature grants, in words, shown before the wallet prompt. */
  scope: z.string(),
  /** When the session it opens ends (ISO 8601). */
  sessionExpiresAt: z.string(),
  /** The order cap schedule the session is bound to. */
  cap: z.array(dexOrderCapSchema),
  /** When this challenge stops being signable (ISO 8601). */
  challengeExpiresAt: z.string(),
});
export type DexAuthChallenge = z.infer<typeof dexAuthChallengeOutputSchema>;

export const dexAuthVerifyInputSchema = z.object({
  challenge: z.string().min(1).max(4096),
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
});
export const dexAuthSessionOutputSchema = z.object({
  wallet: address,
  accessToken: z.string(),
  accessExpiresAt: z.string(),
  refreshToken: z.string(),
  refreshExpiresAt: z.string(),
  scope: z.string(),
  cap: z.array(dexOrderCapSchema),
});
export type DexAuthSession = z.infer<typeof dexAuthSessionOutputSchema>;

export const dexAuthRefreshInputSchema = z.object({ refreshToken: z.string().min(1).max(4096) });
export const dexAuthLogoutInputSchema = z.object({ accessToken: z.string().min(1).max(4096) });
export const dexAuthLogoutOutputSchema = z.object({ revoked: z.literal(true), wallet: address });

export const dexOrdersCountInputSchema = z.object({ wallet: address });
/** How many orders a wallet has, in any state: a count only, so a page can say "no orders yet" before a session. */
export const dexOrdersCountOutputSchema = z.object({ wallet: address, count: z.number().int().nonnegative() });
