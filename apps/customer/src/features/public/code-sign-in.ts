import { z } from 'zod';
import type { ApiResult } from '../../shared/api';

// hand-declared-ok: svc-identity's code sign-in answers (auth.loginCodeRequest, auth.loginCodeResend) have no browser-safe schema in packages/contracts yet

/** `auth.loginCodeRequest` and `auth.loginCodeResend`: the same answer for every name, and no session. */
export const loginCodeAcceptedSchema = z.object({
  accepted: z.literal(true),
  flowId: z.string().guid(),
  resendAfterSeconds: z.number().int().positive(),
});

/** The refusals the code sign-in words itself. Anything else falls back to the shared failure card. */
export const CODE_SIGN_IN_CODES = [
  'auth.codes_unwired',
  'auth.code_invalid',
  'auth.code_expired',
  'auth.too_many_attempts',
  'auth.mfa_required',
  'auth.mfa_invalid',
  'auth.account_frozen',
  'identity.resend_too_soon',
  'vendor.email',
  'vendor.sms',
] as const;
export type CodeSignInCode = (typeof CODE_SIGN_IN_CODES)[number];

export function codeSignInCode(result: Extract<ApiResult<unknown>, { ok: false }>): CodeSignInCode | undefined {
  return (CODE_SIGN_IN_CODES as readonly string[]).includes(result.code ?? '') ? (result.code as CodeSignInCode) : undefined;
}
