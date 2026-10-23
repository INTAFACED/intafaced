/**
 * Fresh second factor for API-key create, scope change, allowlist widening,
 * and secret re-reveal. Same proof as PAYSTEPUP #5011: a TOTP code, a passkey
 * assertion over the server challenge from `auth.stepUpOptions`, or a
 * `pay_step_up_proofs` row for this user and session that has not expired
 * (five minutes, `proveFreshFactor` / STEPUP #4880).
 */
import { z } from 'zod';
import { TRPCError } from '@intafaced/contracts';
import { AuthError, assertDelegateCannotGrant, type AuthService, type PayStepUpFactorProof } from './auth-service.js';
import { userCopy } from '../user-copy.js';

const webauthnAssertion = z.object({
  id: z.string().min(1),
  rawId: z.string().min(1),
  type: z.literal('public-key'),
  response: z.object({
    clientDataJSON: z.string().min(1),
    authenticatorData: z.string().min(1),
    signature: z.string().min(1),
    userHandle: z.string().nullish(),
  }),
  clientExtensionResults: z.record(z.unknown()).optional(),
});

/** Exactly one of a 6-digit authenticator code, a passkey assertion, or a proof id. */
export const apiKeyFactorProofSchema = z.union([
  z.object({ totpCode: z.string().regex(/^\d{6}$/) }).strict(),
  z.object({ webauthn: webauthnAssertion }).strict(),
  z.object({ proofId: z.string().uuid() }).strict(),
]);

export type ApiKeyFactorProof = z.infer<typeof apiKeyFactorProofSchema>;

export type ApiKeyStepUpAudit = {
  sessionId: string;
  factor: 'totp' | 'passkey' | 'proof';
};

export type FreshFactorVerifier = {
  acceptFreshFactor(userId: string, sessionId: string, proof: PayStepUpFactorProof): Promise<'totp' | 'passkey' | 'proof'>;
};

/**
 * pay:refund and pay:payout still need a step-up token whose `stp` claim lists
 * each of them (#5011). Other scopes do not. Returns whether the mint may copy
 * those pay scopes. Throws `auth.step_up_required` when they were asked for
 * without that token.
 */
export function assertPayKeyScopes(
  scopes: readonly string[],
  principal: { scopes: readonly string[]; stp?: readonly string[] | null },
): boolean {
  const money = scopes.filter((scope) => scope === 'pay:refund' || scope === 'pay:payout');
  if (money.length === 0) return false;
  const stepped = new Set(principal.stp ?? []);
  const ok = money.every((scope) => stepped.has(scope) && principal.scopes.includes(scope));
  if (!ok) {
    throw new AuthError("Confirm it's you with a passkey or authenticator code.", 'auth.step_up_required');
  }
  return true;
}

/** An API key cannot mint another. A sub-account cannot mint one either. */
export function assertKeyGrantor(principal: { kid?: string | null; sub_account?: string | null }): void {
  assertDelegateCannotGrant(principal.kid);
  if (principal.sub_account) {
    throw new AuthError('API keys and sub-accounts cannot create keys', 'auth.delegate_cannot_grant');
  }
}

export function rethrowApiKeyDoor(err: unknown): void {
  if (err instanceof TRPCError) throw err;
  if (err instanceof AuthError && err.code === 'auth.delegate_cannot_grant') {
    throw new TRPCError({ code: 'FORBIDDEN', message: err.message, cause: err });
  }
  if (err instanceof AuthError && (err.code === 'auth.step_up_required' || err.code === 'auth.step_up_expired')) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: `${userCopy(err.code)} [${err.code}]`,
      cause: err,
    });
  }
}

/**
 * Missing proof is `auth.step_up_required`. A row past `expires_at` is
 * `auth.step_up_expired`. A live TOTP or passkey is checked by `acceptFreshFactor`.
 */
export async function requireFreshApiKeyFactor(
  auth: FreshFactorVerifier,
  principal: { userId: string; sid: string },
  proof: ApiKeyFactorProof | undefined,
): Promise<ApiKeyStepUpAudit['factor']> {
  if (!proof) {
    throw new AuthError("Confirm it's you with a passkey or authenticator code.", 'auth.step_up_required');
  }
  return auth.acceptFreshFactor(principal.userId, principal.sid, proof);
}
