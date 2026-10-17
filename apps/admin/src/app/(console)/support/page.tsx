import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { SupportDesk } from '@/components/support-desk';
import { loadQueue } from '@/lib/support/server';

/**
 * Support queue: list, ticket, claim. The first paint is svc-support's own answer, with the time it was read; when the
 * founder session lacks the support-staff permission the desk says so instead of showing an empty queue.
 */
export default async function SupportPage() {
  requireModulePage('support');
  const founder = await requireFounderPage();
  const initial = await loadQueue(founder);
  return <SupportDesk initial={initial} userId={founder.session.userId} />;
}
