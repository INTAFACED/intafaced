import 'server-only';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { AdminSessionError, adminSessionConfig, authorizeAdminRequest } from './founder-session';

/** The waits before asking again when identity could not be asked: three reads at most. */
const ASK_AGAIN_AFTER_MS = [250, 750];

/**
 * Identity or Edge gave no answer about this session: a timeout, a 5xx, a 408 or a 429 (Edge's "unavailable", which
 * must not sign anyone out, `services/svc-edge/src/live-authority.ts`). It says nothing about who is signed in.
 */
function noAnswer(error: unknown): boolean {
  if (!(error instanceof AdminSessionError)) return false;
  if (error.code === 'admin.upstream_unavailable') return true;
  return error.code === 'admin.upstream_refused' && (error.status >= 500 || error.status === 408 || error.status === 429);
}

/**
 * The founder this page may be shown to. A session that is missing, refused or not a founder's goes to sign-in. When
 * identity gives no answer it is asked again; if it still gives none the page throws, so the console's error boundary
 * shows the failure. Either way nothing of the page is rendered without a current founder.
 */
export async function requireFounderPage() {
  for (let asked = 0; ; asked += 1) {
    try {
      const config = adminSessionConfig();
      const incoming = await headers();
      if (incoming.get('host') !== new URL(config.origin).host) throw new Error('admin.session_origin');
      return await authorizeAdminRequest(new Request(`${config.origin}/`, { headers: { cookie: incoming.get('cookie') ?? '' } }));
    } catch (error) {
      if (!noAnswer(error)) redirect('/login');
      const wait = ASK_AGAIN_AFTER_MS[asked];
      if (wait === undefined) throw error;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}
