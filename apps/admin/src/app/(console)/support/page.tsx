import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { SupportDesk } from '@/components/support-desk';
import { KbPanel } from '@/components/support-kb-panel';
import { StaffPanel } from '@/components/support-staff-panel';
import { loadKb, loadQueue, loadStaff } from '@/lib/support/server';

/**
 * Support queue and help articles: list, ticket, claim, reply, set status, escalate, case file, rating, and publish or
 * unpublish an article. The first paint is svc-support's own answer, with the time it was read; when the founder session
 * lacks the support-staff permission the desk says so instead of showing an empty queue, and every control stays on the page.
 */
export default async function SupportPage() {
  requireModulePage('support');
  const founder = await requireFounderPage();
  const [initial, kb, staff] = await Promise.all([loadQueue(founder), loadKb(founder), loadStaff(founder)]);
  return (
    <SupportDesk initial={initial} userId={founder.session.userId}>
      <StaffPanel initial={staff} />
      <KbPanel initial={kb} />
    </SupportDesk>
  );
}
