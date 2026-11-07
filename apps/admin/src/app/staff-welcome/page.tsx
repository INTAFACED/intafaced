import { staffInvitationSchema, type StaffInvitation } from '@intafaced/contracts/identity-staff';
import { StaffWelcomeForm } from '@/components/staff-welcome-form';
import { adminSessionConfig, founderEdgeCall } from '@/lib/founder-session';

/**
 * First connection for an invited staff member (J-ops-console-09 #2). The link in their invite mail opens this page; it
 * names who the invite is for and lets them set their own password. Unknown, used and expired links read the same.
 */
export const dynamic = 'force-dynamic';

const TOKEN = /^[A-Za-z0-9_-]{32,128}$/;

async function readInvitation(token: string): Promise<StaffInvitation | null> {
  if (!TOKEN.test(token)) return { state: 'invalid', code: 'identity.staff_invite_invalid' };
  try {
    const raw = await founderEdgeCall(adminSessionConfig(), 'identity', 'staff.invitation', 'GET', { token });
    const parsed = staffInvitationSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export default async function StaffWelcomePage({ searchParams }: { searchParams: Promise<{ token?: string | string[] }> }) {
  const params = await searchParams;
  const token = typeof params.token === 'string' ? params.token : '';
  const invitation = await readInvitation(token);
  return (
    <main className="adm-login" data-testid="staff-welcome">
      <div className="adm-brand adm-brand--stacked">
        <span className="adm-lockup adm-lockup--stacked" role="img" aria-label="INTAFACED" />
        <small>Staff console</small>
      </div>
      <h1>Set up your staff sign-in</h1>
      {invitation === null ? (
        <p role="alert" data-testid="staff-welcome-unavailable">
          svc-identity could not be reached, so this invite cannot be read right now. Nothing was changed. Try the link again later.
        </p>
      ) : invitation.state === 'invalid' ? (
        <p role="alert" data-testid="staff-welcome-invalid">
          This invite link does not work: it is unknown, already used or past its end. Ask a founder for a new invite. Code: {invitation.code}
        </p>
      ) : (
        <StaffWelcomeForm token={token} email={invitation.email} displayName={invitation.displayName} expiresAt={invitation.expiresAt} />
      )}
    </main>
  );
}
