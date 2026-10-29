import Link from 'next/link';
import { requireFounderPage } from '@/lib/founder-page';
import { SupportDesk } from '@/components/support-desk';
import { KbPanel } from '@/components/support-kb-panel';
import { GroupsPanel } from '@/components/support-groups-panel';
import { StaffPanel } from '@/components/support-staff-panel';
import { loadGroups, loadKb, loadQueue, loadStaff } from '@/lib/support/server';
import { queueQueryString, readQueueQuery } from '@/lib/support/queue-query';

/**
 * The support desk page, for the queue (`/support`) and for one request's workspace (`/support/<ticket id>`), which is the
 * same desk with that request open. The first paint is svc-support's own answer, with the time it was read; when the
 * founder session lacks the support-staff permission the desk says so instead of showing an empty queue, and every
 * control stays on the page. The address carries the queue's filter, search and saved view (`?filter=field:value`,
 * `?q=`, `?view=<id>`). Each page calls `requireModulePage('support')` itself, before this.
 */
export async function SupportDeskPage({
  searchParams,
  openTicketId,
}: {
  searchParams: Record<string, string | string[] | undefined>;
  openTicketId?: string;
}) {
  const founder = await requireFounderPage();
  const query = readQueueQuery(searchParams);
  const [initial, kb, staff, groups] = await Promise.all([
    loadQueue(founder, query),
    loadKb(founder),
    loadStaff(founder),
    loadGroups(founder),
  ]);
  return (
    // A new address is a new queue: the desk starts again from what the server read for it.
    <SupportDesk
      key={`${queueQueryString(query)}#${openTicketId ?? ''}`}
      initial={initial}
      userId={founder.session.userId}
      {...(openTicketId ? { openTicketId } : {})}
    >
      <p>
        <Link href="/support/settings">Contact details for the help centre</Link>
      </p>
      <StaffPanel initial={staff} />
      <GroupsPanel initial={groups} />
      <KbPanel initial={kb} />
    </SupportDesk>
  );
}
