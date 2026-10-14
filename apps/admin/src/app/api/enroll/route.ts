import { founderEdgeCall } from '@/lib/founder-session';
import { handleEnrolment } from '@/lib/enrolment-session';

export const dynamic = 'force-dynamic';

/** Abandons enrolment: signs the half-made account out and clears the cookie. It reveals nothing about the account. */
export function DELETE(request: Request) {
  return handleEnrolment(request, { fresh: false }, async ({ session, config }) => {
    let serverRevocation: 'confirmed' | 'unconfirmed' = 'confirmed';
    try {
      await founderEdgeCall(config, 'identity', 'auth.logout', 'POST', { refreshToken: session.refreshToken });
    } catch {
      serverRevocation = 'unconfirmed';
    }
    return { body: { abandoned: true, serverRevocation }, clear: true };
  });
}
