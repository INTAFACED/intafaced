import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { NotifyIncidentsDesk } from '@/components/notify-incidents-desk';
import { loadIncidentDesk } from '@/lib/notify/incidents-server';

/**
 * The incident desk: incidents on the public status page (drafts too), the founders' templates, and the second-founder
 * approval each publish spends. The first paint is the services' own answer, with its read time.
 */
export default async function NotifyIncidentsPage() {
  requireModulePage('notify');
  const founder = await requireFounderPage();
  return <NotifyIncidentsDesk initial={await loadIncidentDesk(founder)} />;
}
