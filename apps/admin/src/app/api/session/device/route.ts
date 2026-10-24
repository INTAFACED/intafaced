import {
  adminDeviceKey,
  adminSessionConfig,
  adminSessionErrorResponse,
  AdminSessionError,
  assertAdminOrigin,
  founderEdgeCall,
  founderSignedIn,
} from '@/lib/founder-session';
import { readAdminJson } from '@/lib/admin-json';

export const dynamic = 'force-dynamic';

const FLOW_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SECRET = /^[A-Za-z0-9_-]{16,128}$/;

/**
 * A founder sign-in waiting on identity's new-device check (I-signin-sessions-07), from the browser that signed in:
 * `approve` with the code identity mailed to the founder's address, or `complete` once it is approved (by that code or
 * from a founder session on a trusted device). Completion signs in like `/api/session` and trusts this browser's key.
 */
export async function POST(request: Request) {
  try {
    const config = adminSessionConfig();
    assertAdminOrigin(request, config, true);
    const input = await readAdminJson(request);
    const allowed = input.action === 'approve' ? ['action', 'flowId', 'secret', 'code'] : ['action', 'flowId', 'secret'];
    if (
      (input.action !== 'approve' && input.action !== 'complete') ||
      Object.keys(input).some((key) => !allowed.includes(key)) ||
      typeof input.flowId !== 'string' ||
      !FLOW_ID.test(input.flowId) ||
      typeof input.secret !== 'string' ||
      !SECRET.test(input.secret) ||
      (input.action === 'approve' && (typeof input.code !== 'string' || !/^\d{6}$/.test(input.code.trim())))
    )
      throw new AdminSessionError('admin.login_input', 400);
    const device = adminDeviceKey(request.headers.get('cookie'));
    const flow = { flowId: input.flowId, secret: input.secret, deviceKey: device.key };
    if (input.action === 'approve') {
      await founderEdgeCall(config, 'identity', 'auth.deviceApprove', 'POST', { ...flow, code: String(input.code).trim() });
      return Response.json({ approved: true }, { headers: { 'cache-control': 'no-store', 'set-cookie': device.cookie } });
    }
    const raw = await founderEdgeCall(config, 'identity', 'auth.deviceComplete', 'POST', flow);
    return await founderSignedIn(raw, config, device.cookie);
  } catch (error) {
    return adminSessionErrorResponse(error);
  }
}
