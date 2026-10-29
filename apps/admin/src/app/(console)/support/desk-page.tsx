import Link from 'next/link';
import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { SupportDesk } from '@/components/support-desk';
import { KbPanel } from '@/components/support-kb-panel';
import { GroupsPanel } from '@/components/support-groups-panel';
import { StaffPanel } from '@/components/support-staff-panel';
import { loadGroups, loadKb, loadQueue, loadStaff } from '@/lib/support/server';
import { queueQueryString, type QueueQuery } from '@/lib/support/queue-query';

/**
 * The support desk page, at `/support` or, with one request open in its workspace, at `/support/<ticketId>`.
 * Support queue and help articles: list, ticket, claim, reply, set status, escalate, case file, rating, and publish or
 * unpublish an article. The first paint is svc-support's own answer, with the time it was read; when the founder session
 * lacks the support-staff permission the desk says so instead of showing an empty queue, and every control stays on the page.
 * The address carries the queue's filter, search and saved view (`?filter=field:value`, `?q=`, `?view=<id>`).
 */
export async function SupportDeskPage({ query, ticketId }: { query: QueueQuery; ticketId?: string }) {
  requireModulePage('support');
  const founder = await requireFounderPage();
  const [initial, kb, staff, groups] = await Promise.all([
    loadQueue(founder, query),
    loadKb(founder),
    loadStaff(founder),
    loadGroups(founder),
  ]);
  return (
    // A new address is a new queue: the desk starts again from what the server read for it.
    <SupportDesk
      key={`${queueQueryString(query)}:${ticketId ?? ''}`}
      initial={initial}
      userId={founder.session.userId}
      openTicketId={ticketId}
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
