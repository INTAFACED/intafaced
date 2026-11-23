import { z } from 'zod';

/**
 * Wire types for wallet orders on the Protocol plane (D-limit-dca-01 to -04), version 1: svc-dex's `auth.*` order
 * session and the order vault's orders. The person may be signed out of INTAFACED: what proves they own the orders is a
 * signature from the wallet itself. `auth.challenge` writes an EIP-712 order session (its scope, expiry and the order cap
 * schedule, all shown before the wallet is asked), `auth.verify` checks the wallet signed it and spends its nonce once,
 * and every order call carries the access token it returns. The service reads the maker from the token it issued, never
 * from an address the caller names. Every call is a POST (a tRPC mutation), reads included, so a token travels in a
 * body and never in a URL an access log keeps. Each call's record, with its refusals, is `dex-procedures.ts`.
 */
export const PROTOCOL_DEX_ORDERS_CONTRACT_VERSION = 1 as const;

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
  /** The order session itself, as the wallet hashes it: `expiresAt` is unix seconds as a decimal string (a uint256). */
  message: z.object({
    wallet: address,
    scope: z.string(),
    cap: z.string(),
    expiresAt: z.string().regex(/^\d+$/),
    nonce: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  }),
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
