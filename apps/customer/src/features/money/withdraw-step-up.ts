// hand-declared-ok: the step-up answer is declared in svc-identity, not in a browser-safe @intafaced/contracts export
import { z } from 'zod';
import type { ApiClient, ApiResult } from '../../shared/api';
import { requestPasskeyAssertion } from '../session/webauthn';

const minted = z.object({ accessToken: z.string().min(1), expiresAt: z.string().min(1), scopes: z.array(z.string()) });

/** What the person answers with: a 6-digit authenticator code, a recovery code, or a passkey. */
export type WithdrawStepUpMethod = { code: string } | { passkey: true };
export type WithdrawToken = { accessToken: string; expiresAt: string };

const CODE = /^(\d{6}|[0-9A-Fa-f]{5}-[0-9A-Fa-f]{5})$/;
export const isStepUpCode = (value: string) => CODE.test(value.trim());

/**
 * Confirms it's this person with a fresh factor and returns the short token (five minutes at most) that carries
 * `trade:withdraw`. The caller sends exactly one action with it as that call's own bearer and lets it go: it is never
 * stored, never put in the session and never reused. A wrong code or a refused passkey never ends the session.
 */
export async function mintWithdrawToken(
  api: ApiClient,
  method: WithdrawStepUpMethod,
  signal?: AbortSignal,
): Promise<ApiResult<WithdrawToken>> {
  let proof: { totpCode: string } | { webauthn: unknown };
  if ('code' in method) {
    const code = method.code.trim();
    if (!CODE.test(code)) return { ok: false, reason: 'invalid_response', message: 'stepUp.code_malformed', code: 'stepUp.code_malformed' };
    proof = { totpCode: code };
  } else {
    const assertion = await requestPasskeyAssertion(api, signal);
    if (!assertion.ok) return assertion;
    proof = { webauthn: assertion.data };
  }
  const result = await api.mutate('identity', 'auth.stepUp', proof, minted, {
    signal,
    keepSessionFor: ['auth.mfa_invalid', 'auth.webauthn_invalid', 'auth.mfa_not_enrolled', 'auth.webauthn_not_enrolled'],
  });
  if (!result.ok) return result;
  if (!result.data.scopes.includes('trade:withdraw'))
    return { ok: false, reason: 'invalid_response', message: 'stepUp.scope_missing', code: 'stepUp.scope_missing' };
  return { ok: true, data: { accessToken: result.data.accessToken, expiresAt: result.data.expiresAt } };
}
