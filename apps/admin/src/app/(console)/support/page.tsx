import Link from 'next/link';
import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { SupportDesk } from '@/components/support-desk';
import { KbPanel } from '@/components/support-kb-panel';
import { GroupsPanel } from '@/components/support-groups-panel';
import { StaffPanel } from '@/components/support-staff-panel';
import { MacrosPanel } from '@/components/support-macros-panel';
import { loadGroups, loadKb, loadQueue, loadStaff } from '@/lib/support/server';
import { queueQueryString, readQueueQuery } from '@/lib/support/queue-query';

/**
 * Support queue and help articles: list, ticket, claim, reply, set status, escalate, case file, rating, and publish or
 * unpublish an article. The first paint is svc-support's own answer, with the time it was read; when the founder session
 * lacks the support-staff permission the desk says so instead of showing an empty queue, and every control stays on the page.
 * The address carries the queue's filter, search and saved view (`?filter=field:value`, `?q=`, `?view=<id>`).
 */
export default async function SupportPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  requireModulePage('support');
  const founder = await requireFounderPage();
  const query = readQueueQuery(await searchParams);
  const [initial, kb, staff, groups] = await Promise.all([
    loadQueue(founder, query),
    loadKb(founder),
    loadStaff(founder),
    loadGroups(founder),
  ]);
  return (
    // A new address is a new queue: the desk starts again from what the server read for it.
    <SupportDesk key={queueQueryString(query)} initial={initial} userId={founder.session.userId}>
      <p>
        <Link href="/support/settings">Contact details for the help centre</Link>
      </p>
      <StaffPanel initial={staff} />
      <MacrosPanel />
      <GroupsPanel initial={groups} />
      <KbPanel initial={kb} />
    </SupportDesk>
  );
}
