import {
  adminSessionConfig,
  adminSessionErrorResponse,
  AdminSessionError,
  assertAdminOrigin,
  founderEdgeCall,
} from '@/lib/founder-session';
import {
  ENROLMENT_UPSTREAM,
  enrolmentCookie,
  enrolmentCookieAge,
  enrolmentIsOpen,
  enrolmentOffResponse,
  newEnrolmentSession,
  sealEnrolmentSession,
} from '@/lib/enrolment-session';
import { readAdminJson } from '@/lib/admin-json';
import { limitedResponse, registerLimiter } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

const KEYS = ['invite', 'handle', 'email', 'password'];

/**
 * Creates the account from an invite. No enrolment session exists yet, so there is no CSRF token to check: the Origin check is the
 * guard. The reply carries the CSRF token for the steps that follow, and not the account ID, which is shown only at the end.
 */
export async function POST(request: Request) {
  if (!enrolmentIsOpen()) return enrolmentOffResponse();
  try {
    const config = adminSessionConfig();
    assertAdminOrigin(request, config, true);
    // Public and unauthenticated: count every attempt per client before doing anything else (see lib/rate-limit).
    const limited = limitedResponse(registerLimiter, request);
    if (limited) return limited;
    const input = await readAdminJson(request);
    const { invite, handle, email, password } = input;
    if (
      Object.keys(input).some((key) => !KEYS.includes(key)) ||
      typeof invite !== 'string' ||
      !invite.trim() ||
      invite.length > 64 ||
      typeof handle !== 'string' ||
      !handle.trim() ||
      handle.length > 32 ||
      typeof email !== 'string' ||
      !email.trim() ||
      email.length > 254 ||
      typeof password !== 'string' ||
      password.length < 12 ||
      password.length > 200
    )
      throw new AdminSessionError('admin.enrol_input', 400);
    const raw = await founderEdgeCall(config, 'identity', 'auth.registerFounder', 'POST', {
      invite: invite.trim(),
      handle: handle.trim(),
      email: email.trim(),
      password,
    });
    let cookie: string;
    let session;
    try {
      session = newEnrolmentSession(raw);
      cookie = sealEnrolmentSession(session, config);
    } catch (error) {
      // The account exists but we cannot hold its session: end that session rather than leave a live token nobody holds.
      const refreshToken = (raw as { refreshToken?: unknown } | null)?.refreshToken;
      if (typeof refreshToken === 'string')
        await founderEdgeCall(config, 'identity', 'auth.logout', 'POST', { refreshToken }).catch(() => undefined);
      throw error;
    }
    return Response.json(
      { csrf: session.csrf },
      { headers: { 'cache-control': 'no-store', 'set-cookie': enrolmentCookie(cookie, enrolmentCookieAge(session)) } },
    );
  } catch (error) {
    return adminSessionErrorResponse(error, ENROLMENT_UPSTREAM);
  }
}
