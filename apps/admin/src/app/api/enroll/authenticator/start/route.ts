import { AdminSessionError, founderEdgeCall } from '@/lib/founder-session';
import { handleEnrolment } from '@/lib/enrolment-session';

export const dynamic = 'force-dynamic';

const SECRET = /^[A-Z2-7]{16,128}$/;
const RECOVERY = /^[A-Za-z0-9]{5}-[A-Za-z0-9]{5}$/;

/** Starts authenticator enrolment. The secret, link and recovery codes go to this browser only: nothing here stores or logs them. */
export function POST(request: Request) {
  return handleEnrolment(request, {}, async ({ session, config }) => {
    if (session.totpConfirmed) throw new AdminSessionError('admin.enrolment_totp_done', 409);
    const raw = (await founderEdgeCall(config, 'identity', 'totp.enrol', 'POST', {}, session.accessToken)) as {
      secret?: unknown;
      uri?: unknown;
      recoveryCodes?: unknown;
    } | null;
    if (
      !raw ||
      typeof raw.secret !== 'string' ||
      !SECRET.test(raw.secret) ||
      typeof raw.uri !== 'string' ||
      !raw.uri.startsWith('otpauth://totp/') ||
      raw.uri.length > 512 ||
      !Array.isArray(raw.recoveryCodes) ||
      raw.recoveryCodes.length !== 10 ||
      !raw.recoveryCodes.every((code) => typeof code === 'string' && RECOVERY.test(code))
    )
      throw new AdminSessionError('admin.upstream_invalid', 502);
    return { body: { secret: raw.secret, uri: raw.uri, recoveryCodes: raw.recoveryCodes } };
  });
}
