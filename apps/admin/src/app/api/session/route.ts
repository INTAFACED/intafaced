import {
  adminDeviceKey,
  adminSessionConfig,
  adminSessionErrorResponse,
  AdminSessionError,
  assertAdminOrigin,
  assertAdminCsrf,
  authorizeAdminRequest,
  founderCookie,
  founderEdgeCall,
  founderSignedIn,
  openFounderSession,
} from '@/lib/founder-session';
import { readAdminJson } from '@/lib/admin-json';
import { signInChallengeProofSchema } from '@intafaced/contracts/identity-signin-challenge';

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
  let device: { key: string; cookie: string } | undefined;
  try {
    const config = adminSessionConfig();
    assertAdminOrigin(request, config, true);
    const input = await readAdminJson(request);
    if (
      Object.keys(input).some((key) => !['identifier', 'password', 'totpCode', 'challenge'].includes(key)) ||
      // A solved sign-in challenge (I-signin-sessions-30), solved in the founder's browser after auth.challenge_required.
      (input.challenge !== undefined && !signInChallengeProofSchema.safeParse(input.challenge).success) ||
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
    // Identity's new-device check knows this browser by its key; a browser it has not seen waits for approval
    // (`/api/session/device`), and the key is kept so the approval lands on this same browser.
    device = adminDeviceKey(request.headers.get('cookie'));
    const raw = await founderEdgeCall(config, 'identity', 'auth.login', 'POST', { ...input, deviceKey: device.key }, undefined, {
      userAgent: request.headers.get('user-agent'),
    });
    return await founderSignedIn(raw, config, device.cookie);
  } catch (error) {
    const response = adminSessionErrorResponse(error);
    if (device && error instanceof AdminSessionError && error.deviceAuthorisation) response.headers.append('set-cookie', device.cookie);
    return response;
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
