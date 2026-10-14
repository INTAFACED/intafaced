import { AdminSessionError, founderEdgeCall } from '@/lib/founder-session';
import { handleEnrolment, liveStepUpToken, withStepUp } from '@/lib/enrolment-session';
import { readAdminJson } from '@/lib/admin-json';

export const dynamic = 'force-dynamic';

/**
 * Passkey registration options, only after the authenticator is confirmed.
 *
 * Adding a passkey to an account that has an authenticator needs an MFA session, which an enrolment session is not. So a fresh
 * authenticator code (`{code}`) is exchanged for a five-minute step-up token (`auth.stepUp`), which is kept in the sealed cookie
 * and never returned. Without a code, a step-up token still held from a moment ago is used; with neither, identity's own gate
 * refuses (`auth.mfa_required`).
 */
export function POST(request: Request) {
  return handleEnrolment(request, { confirmed: true }, async ({ session, config }) => {
    const input = await readAdminJson(request);
    if (
      Object.keys(input).some((key) => key !== 'code') ||
      (input.code !== undefined && (typeof input.code !== 'string' || !/^\d{6}$/.test(input.code)))
    )
      throw new AdminSessionError('admin.enrol_input', 400);
    let current = session;
    if (typeof input.code === 'string') {
      const raw = (await founderEdgeCall(config, 'identity', 'auth.stepUp', 'POST', { totpCode: input.code }, session.accessToken)) as {
        accessToken?: unknown;
        expiresAt?: unknown;
      } | null;
      if (!raw || typeof raw.accessToken !== 'string' || !raw.accessToken || raw.accessToken.length > 2600)
        throw new AdminSessionError('admin.upstream_invalid', 502);
      current = withStepUp(session, raw.accessToken, raw.expiresAt);
    }
    const options = await founderEdgeCall(
      config,
      'identity',
      'webauthn.registerOptions',
      'POST',
      {},
      liveStepUpToken(current) ?? current.accessToken,
    );
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new AdminSessionError('admin.upstream_invalid', 502);
    return { body: options, session: current };
  });
}
