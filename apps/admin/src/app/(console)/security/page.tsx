import { FounderSecurity } from '@/components/founder-security';
import { requireFounderPage } from '@/lib/founder-page';

/**
 * The founder's own sign-in settings: password, authenticator, recovery codes and passkeys. It belongs to no module, so it
 * stays available whatever ADMIN_MODULES says (see `ALWAYS_ON_ROUTES` in lib/modules.ts).
 */
export default async function SecurityPage() {
  const { session } = await requireFounderPage();
  return <FounderSecurity csrf={session.csrf} />;
}
