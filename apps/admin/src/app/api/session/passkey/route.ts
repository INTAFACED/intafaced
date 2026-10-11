import {
  adminSessionConfig,
  adminSessionErrorResponse,
  AdminSessionError,
  assertAdminOrigin,
  assertCurrentFounder,
  founderCookie,
  founderEdgeCall,
  newFounderSession,
  sealFounderSession,
} from '@/lib/founder-session';
import { readAdminJson } from '@/lib/admin-json';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const config = adminSessionConfig();
    assertAdminOrigin(request, config, true);
    const input = await readAdminJson(request);
    if (
      Object.keys(input).some((key) => !['action', 'identifier', 'credential'].includes(key)) ||
      typeof input.identifier !== 'string' ||
      !input.identifier.trim() ||
      input.identifier.length > 254
    )
      throw new AdminSessionError('admin.login_input', 400);
    if (input.action === 'options' && !('credential' in input)) {
      const options = await founderEdgeCall(config, 'identity', 'webauthn.authOptions', 'POST', { identifier: input.identifier });
      return Response.json(options, { headers: { 'cache-control': 'no-store' } });
    }
    if (input.action !== 'authenticate' || !input.credential || typeof input.credential !== 'object' || Array.isArray(input.credential))
      throw new AdminSessionError('admin.login_input', 400);
    const raw = await founderEdgeCall(config, 'identity', 'webauthn.authVerify', 'POST', {
      identifier: input.identifier,
      credential: input.credential,
    });
    const session = newFounderSession(raw);
    try {
      await assertCurrentFounder(session, config);
    } catch (error) {
      await founderEdgeCall(config, 'identity', 'auth.logout', 'POST', { refreshToken: session.refreshToken }).catch(() => undefined);
      throw error;
    }
    return Response.json(
      { userId: session.userId, expiresAt: session.expiresAt, csrf: session.csrf },
      {
        headers: {
          'cache-control': 'no-store',
          'set-cookie': founderCookie(sealFounderSession(session, config), (Date.parse(session.expiresAt) - Date.now()) / 1000),
        },
      },
    );
  } catch (error) {
    return adminSessionErrorResponse(error);
  }
}
