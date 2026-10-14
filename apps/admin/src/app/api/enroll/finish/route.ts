import { founderEdgeCall } from '@/lib/founder-session';
import { handleEnrolment } from '@/lib/enrolment-session';

export const dynamic = 'force-dynamic';

/**
 * Ends enrolment: signs the new account out and clears the cookie. This is the only place the account ID is revealed, and the
 * account never becomes a console session. Logout needs only the refresh token, so the access token is not refreshed first.
 */
export function POST(request: Request) {
  return handleEnrolment(request, { confirmed: true, fresh: false }, async ({ session, config }) => {
    let serverRevocation: 'confirmed' | 'unconfirmed' = 'confirmed';
    try {
      await founderEdgeCall(config, 'identity', 'auth.logout', 'POST', { refreshToken: session.refreshToken });
    } catch {
      serverRevocation = 'unconfirmed';
    }
    return { body: { userId: session.userId, serverRevocation }, clear: true };
  });
}
