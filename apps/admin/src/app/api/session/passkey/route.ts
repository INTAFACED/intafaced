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
  founderEdgeRecordCall,
} from '@/lib/founder-session';
import { readAdminJson } from '@/lib/admin-json';
import { IDENTITY_WEBAUTHN_AUTH_OPTIONS } from '@intafaced/contracts/identity-webauthn-procedures';
import { IDENTITY_AUTH_LOGOUT } from '@intafaced/contracts/identity-auth-procedures';

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
      const options = await founderEdgeRecordCall(config, IDENTITY_WEBAUTHN_AUTH_OPTIONS, { identifier: input.identifier });
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
      await founderEdgeRecordCall(config, IDENTITY_AUTH_LOGOUT, { refreshToken: session.refreshToken }).catch(() => undefined);
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
