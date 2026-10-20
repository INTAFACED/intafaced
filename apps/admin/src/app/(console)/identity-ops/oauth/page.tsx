import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { OAuthAppsDesk } from '@/components/oauth-apps-desk';
import { loadOAuthQueue } from '@/lib/oauth-ops/server';

/**
 * Third-party OAuth apps waiting for an operator's decision, and the ones already approved or suspended. The first paint is
 * svc-identity's own answer with the time it was read.
 */
export default async function Page() {
  requireModulePage('identity-ops');
  const founder = await requireFounderPage();
  return <OAuthAppsDesk initial={await loadOAuthQueue(founder, 'pending')} />;
}
