import { z } from 'zod';
import { statusChallengeMet } from './status-subscriptions.js';

/**
 * svc-identity `auth.challenge` (I-signin-sessions-30, J-identity-02 #2): the self-hosted sign-in challenge. After the
 * owner's number of failed sign-ins from one address (every sign-in when the owner left that number blank), `auth.login`
 * refuses `auth.challenge_required` until the request carries a solved challenge. The browser asks `auth.challenge` for
 * a signed token and its difficulty, finds a nonce whose SHA-256 over `signInChallengeText(token, nonce)` starts with
 * `bits` zero bits, and sends both as `challenge` on the next `auth.login`. A token is good once, until `expiresAt`. No
 * third-party captcha is used. A blank difficulty, lifetime or signing key refuses `identity.challenge_unconfigured`.
 * Browser safe: the check uses only the hash the caller passes in.
 */
export const signInChallengeSchema = z.object({
  token: z.string().min(1).max(512),
  bits: z.number().int().min(1).max(32),
  expiresAt: z.string().datetime({ offset: true }),
});
export type SignInChallenge = z.infer<typeof signInChallengeSchema>;

/** The solved challenge `auth.login` takes. */
export const signInChallengeProofSchema = z.object({ token: z.string().min(1).max(512), nonce: z.string().min(1).max(64) }).strict();
export type SignInChallengeProof = z.infer<typeof signInChallengeProofSchema>;

/** The text a sign-in proof of work hashes. */
export const signInChallengeText = (token: string, nonce: string): string => `signin:${token}:${nonce}`;

/** True when sha256 `digest` (raw bytes) starts with `bits` zero bits. */
export const signInChallengeMet = (digest: Uint8Array, bits: number): boolean => statusChallengeMet(digest, bits);
