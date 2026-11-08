import { staffAcceptResultSchema } from '@intafaced/contracts/identity-staff';
import { readAdminJson } from '@/lib/admin-json';
import {
  AdminSessionError,
  adminDeviceKey,
  adminSessionConfig,
  adminSessionErrorResponse,
  assertAdminOrigin,
  founderEdgeCall,
} from '@/lib/founder-session';

/**
 * A staff member's first connection (J-ops-console-09 #2). Public: the one-time token from the invite mail is the only
 * authority. They set their own password; svc-identity makes their account with the invited email, spends the token and
 * turns the staff record active at once. No session is opened here: they sign in on /login after.
 */

export const dynamic = 'force-dynamic';

const TOKEN = /^[A-Za-z0-9_-]{32,128}$/;

export async function POST(request: Request) {
  try {
    const config = adminSessionConfig();
    assertAdminOrigin(request, config, true);
    const input = await readAdminJson(request);
    if (
      Object.keys(input).some((key) => key !== 'token' && key !== 'password') ||
      typeof input.token !== 'string' ||
      !TOKEN.test(input.token) ||
      typeof input.password !== 'string' ||
      input.password.length < 1 ||
      input.password.length > 256
    )
      throw new AdminSessionError('admin.request_invalid', 400);
    // This browser's console device key, trusted as at sign-up (the cookie is set here when it had none).
    const device = adminDeviceKey(request.headers.get('cookie'));
    const raw = await founderEdgeCall(config, 'identity', 'staff.acceptInvite', 'POST', {
      token: input.token,
      password: input.password,
      deviceKey: device.key,
    });
    const parsed = staffAcceptResultSchema.safeParse(raw);
    if (!parsed.success) throw new AdminSessionError('admin.upstream_invalid', 502);
    const { staff } = parsed.data;
    return Response.json(
      { ok: true, email: staff.email, displayName: staff.displayName, status: staff.status },
      { headers: { 'cache-control': 'no-store', 'set-cookie': device.cookie } },
    );
  } catch (error) {
    return adminSessionErrorResponse(error);
  }
}
