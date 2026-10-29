import { notFound } from 'next/navigation';
import { isTicketId } from '@/lib/support/model';
import { readQueueQuery } from '@/lib/support/queue-query';
import { SupportDeskPage } from '../desk-page';

/** One request's workspace, at its own address, beside the queue. An address that is not a request id is not a page. */
export default async function SupportTicketPage({
  params,
  searchParams,
}: {
  params: Promise<{ ticketId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { ticketId } = await params;
  if (!isTicketId(ticketId)) notFound();
  return <SupportDeskPage query={readQueueQuery(await searchParams)} ticketId={ticketId.toLowerCase()} />;
}
