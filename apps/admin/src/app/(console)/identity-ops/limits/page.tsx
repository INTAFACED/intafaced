import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { LimitRequestsDesk } from '@/components/limit-requests-desk';
import { loadLimitDesk } from '@/lib/identity-ops/limits-server';

/**
 * Requests for a higher API rate limit (DV-limits-03, J-developer-06 #6): waiting requests first, each granted in full,
 * in part or refused by a support reviewer, and the audit entry each decision wrote. svc-identity's own answer.
 */
export default async function Page() {
  requireModulePage('identity-ops');
  const founder = await requireFounderPage();
  return <LimitRequestsDesk initial={await loadLimitDesk(founder)} />;
}
