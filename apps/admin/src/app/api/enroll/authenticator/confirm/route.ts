import { AdminSessionError, founderEdgeCall } from '@/lib/founder-session';
import { handleEnrolment } from '@/lib/enrolment-session';
import { readAdminJson } from '@/lib/admin-json';

export const dynamic = 'force-dynamic';

/**
 * Confirms the first authenticator code. Identity's `totp.confirm` takes the secret as well as the code (it checks the code
 * against that secret), and this server keeps no copy, so the browser sends back the secret it was shown.
 */
export function POST(request: Request) {
  return handleEnrolment(request, {}, async ({ session, config }) => {
    const input = await readAdminJson(request);
    if (
      Object.keys(input).some((key) => !['code', 'secret'].includes(key)) ||
      typeof input.code !== 'string' ||
      !/^\d{6}$/.test(input.code) ||
      typeof input.secret !== 'string' ||
      !/^[A-Z2-7]{16,128}$/.test(input.secret)
    )
      throw new AdminSessionError('admin.enrol_input', 400);
    await founderEdgeCall(config, 'identity', 'totp.confirm', 'POST', { secret: input.secret, code: input.code }, session.accessToken);
    return { body: { confirmed: true }, session: { ...session, totpConfirmed: true } };
  });
}
