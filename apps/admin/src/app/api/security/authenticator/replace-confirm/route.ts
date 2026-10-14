import { AdminSessionError, adminSessionErrorResponse, founderEdgeCall } from '@/lib/founder-session';
import { authorizedInput, NO_STORE, SECURITY_UPSTREAM } from '../../guard';

export const dynamic = 'force-dynamic';

/**
 * Confirm the new authenticator with a code from it. Uses the founder's own token: the proof was given at replace-begin.
 * (If svc-identity later asks for a fresh step-up here, wrap this call in `withStepUp` like the other routes.)
 */
export async function POST(request: Request) {
  try {
    const { session, config, input } = await authorizedInput(request, ['code']);
    if (typeof input.code !== 'string' || !/^\d{6}$/.test(input.code)) throw new AdminSessionError('admin.security_input', 400);
    await founderEdgeCall(config, 'identity', 'totp.replaceConfirm', 'POST', { code: input.code }, session.accessToken);
    return Response.json({ ok: true }, { headers: NO_STORE });
  } catch (error) {
    return adminSessionErrorResponse(error, SECURITY_UPSTREAM);
  }
}
