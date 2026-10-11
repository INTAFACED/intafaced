import {
  adminSessionConfig,
  adminSessionErrorResponse,
  AdminSessionError,
  assertAdminOrigin,
  assertAdminCsrf,
  assertCurrentFounder,
  authorizeAdminRequest,
  founderCookie,
  founderEdgeCall,
  newFounderSession,
  openFounderSession,
  sealFounderSession,
} from '@/lib/founder-session';
import { readAdminJson } from '@/lib/admin-json';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const { session } = await authorizeAdminRequest(request);
    return Response.json(
      { userId: session.userId, expiresAt: session.expiresAt, csrf: session.csrf },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (error) {
    return adminSessionErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const config = adminSessionConfig();
    assertAdminOrigin(request, config, true);
    const input = await readAdminJson(request);
    if (
      Object.keys(input).some((key) => !['identifier', 'password', 'totpCode'].includes(key)) ||
      typeof input.identifier !== 'string' ||
      !input.identifier.trim() ||
      input.identifier.length > 254 ||
      typeof input.password !== 'string' ||
      !input.password ||
      input.password.length > 1024 ||
      typeof input.totpCode !== 'string' ||
      !/^(\d{6}|[0-9A-Fa-f]{5}-[0-9A-Fa-f]{5})$/.test(input.totpCode)
    )
      throw new AdminSessionError('admin.login_input', 400);
    const raw = await founderEdgeCall(config, 'identity', 'auth.login', 'POST', input);
    const session = newFounderSession(raw);
    try {
      await assertCurrentFounder(session, config);
    } catch (error) {
      await founderEdgeCall(config, 'identity', 'auth.logout', 'POST', { refreshToken: session.refreshToken }).catch(() => undefined);
      throw error;
    }
    const cookie = sealFounderSession(session, config);
    return Response.json(
      { userId: session.userId, expiresAt: session.expiresAt, csrf: session.csrf },
      {
        headers: { 'cache-control': 'no-store', 'set-cookie': founderCookie(cookie, (Date.parse(session.expiresAt) - Date.now()) / 1000) },
      },
    );
  } catch (error) {
    return adminSessionErrorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const config = adminSessionConfig();
    assertAdminOrigin(request, config, true);
    const session = openFounderSession(request.headers.get('cookie'), config);
    assertAdminCsrf(request, session);
    let serverRevocation: 'confirmed' | 'unconfirmed' = 'confirmed';
    try {
      await founderEdgeCall(config, 'identity', 'auth.logout', 'POST', { refreshToken: session.refreshToken });
    } catch {
      serverRevocation = 'unconfirmed';
    }
    return Response.json(
      { signedOut: true, serverRevocation },
      { headers: { 'cache-control': 'no-store', 'set-cookie': founderCookie('', 0) } },
    );
  } catch (error) {
    return adminSessionErrorResponse(error);
  }
}
