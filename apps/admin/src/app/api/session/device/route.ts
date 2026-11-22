import {
  DEVICE_FLOW_ID,
  DEVICE_FLOW_SECRET,
  adminDeviceKey,
  adminSessionConfig,
  adminSessionErrorResponse,
  AdminSessionError,
  assertAdminOrigin,
  founderSignedIn,
  founderEdgeRecordCall,
} from '@/lib/founder-session';
import { readAdminJson } from '@/lib/admin-json';
import { IDENTITY_AUTH_DEVICE_APPROVE, IDENTITY_AUTH_DEVICE_COMPLETE } from '@intafaced/contracts/identity-auth-procedures';

export const dynamic = 'force-dynamic';

/**
 * A founder sign-in waiting on identity's new-device check (I-signin-sessions-07), from the browser that signed in:
 * `approve` with the code identity mailed to the founder's address (identity approves and signs in at once), or
 * `complete` once a founder session on a trusted device approved it. Either signs in like `/api/session`, and identity
 * trusts this browser's key.
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
      !DEVICE_FLOW_ID.test(input.flowId) ||
      typeof input.secret !== 'string' ||
      !DEVICE_FLOW_SECRET.test(input.secret) ||
      (input.action === 'approve' && (typeof input.code !== 'string' || !/^\d{6}$/.test(input.code.trim())))
    )
      throw new AdminSessionError('admin.login_input', 400);
    const device = adminDeviceKey(request.headers.get('cookie'));
    const flow = { flowId: input.flowId, secret: input.secret, deviceKey: device.key };
    const signIn = { userAgent: request.headers.get('user-agent') };
    const raw =
      input.action === 'approve'
        ? await founderEdgeRecordCall(config, IDENTITY_AUTH_DEVICE_APPROVE, { ...flow, code: String(input.code).trim() }, undefined, signIn)
        : await founderEdgeRecordCall(config, IDENTITY_AUTH_DEVICE_COMPLETE, flow, undefined, signIn);
    return await founderSignedIn(raw, config, device.cookie);
  } catch (error) {
    return adminSessionErrorResponse(error);
  }
}
