// hand-declared-ok: the step-up begin and complete answers are declared in svc-identity, not in packages/contracts yet
import { z } from 'zod';
import type { ApiClient, ApiResult } from '../../shared/api';
import { signAssertion } from '../session/webauthn';

const begun = z
  .object({
    challengeId: z.string().uuid(),
    totp: z.boolean(),
    webauthn: z
      .object({
        challenge: z.string(),
        timeout: z.number().optional(),
        rpId: z.string().optional(),
        allowCredentials: z
          .array(z.object({ type: z.literal('public-key'), id: z.string(), transports: z.array(z.string()).optional() }))
          .optional(),
        userVerification: z.enum(['required', 'preferred', 'discouraged']).optional(),
      })
      .nullable(),
  })
  .passthrough();
const approved = z.object({ stepUpApprovalId: z.string().min(1) }).passthrough();

// `target` is left out for a door that names none (the anti-phishing code is never sent as a target).
// `amount` is sent for a door that binds one (a send's amount), exactly as the fields carry it.
export type StepUpBegin = { scope: string; purpose: string; target?: string; amount?: string; fields: Record<string, string> };
export type StepUpMethod = { totpCode: string } | { passkey: true };

/**
 * Confirms one security change with a fresh factor and returns the single-use approval id to send with it. The request
 * names the same scope, target and fields the service re-hashes when the change arrives. A 6-digit code or a passkey
 * (when the account has one) answers; a wrong code never ends the session.
 */
export async function confirmWithStepUp(
  api: ApiClient,
  request: StepUpBegin,
  method: StepUpMethod,
  signal?: AbortSignal,
): Promise<ApiResult<{ stepUpApprovalId: string }>> {
  const start = await api.mutate('identity', 'stepUp.begin', request, begun, { signal });
  if (!start.ok) return start;
  if ('totpCode' in method) {
    return api.mutate('identity', 'stepUp.complete', { challengeId: start.data.challengeId, totpCode: method.totpCode }, approved, {
      signal,
      keepSessionFor: ['auth.mfa_invalid'],
    });
  }
  if (!start.data.webauthn) {
    return { ok: false, reason: 'not_supported', message: 'stepUp.no_passkey', code: 'stepUp.no_passkey' };
  }
  const assertion = await signAssertion(start.data.webauthn, signal);
  if (!assertion.ok) return assertion;
  return api.mutate('identity', 'stepUp.complete', { challengeId: start.data.challengeId, webauthn: assertion.data }, approved, {
    signal,
    keepSessionFor: ['auth.webauthn_invalid'],
  });
}
