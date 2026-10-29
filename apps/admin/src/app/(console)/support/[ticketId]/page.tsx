import { notFound } from 'next/navigation';
import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { SupportDesk } from '@/components/support-desk';
import { isTicketId } from '@/lib/support/model';
import { loadQueue } from '@/lib/support/server';

/**
 * One request's workspace at its own address (SP-tickets-09): the support queue with this request open, so it can be
 * linked, reloaded and reached from "Claim the next request". The request is read from svc-support like any other; one
 * this founder may not see says so in the panel.
 */
export default async function SupportTicketPage({ params }: { params: Promise<{ ticketId: string }> }) {
  requireModulePage('support');
  const founder = await requireFounderPage();
  const { ticketId } = await params;
  if (!isTicketId(ticketId)) notFound();
  const initial = await loadQueue(founder);
  return <SupportDesk key={ticketId} initial={initial} userId={founder.session.userId} openTicketId={ticketId} />;
}
