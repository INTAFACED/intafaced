import { notFound } from 'next/navigation';
import { isTicketId } from '@/lib/support/model';
import { requireModulePage } from '@/lib/module-page-guard';
import { SupportDeskPage } from '../desk-page';

/** One request's workspace: the support desk with this request open, at an address that can be shared and reloaded. */
export default async function SupportTicketPage({
  params,
  searchParams,
}: {
  params: Promise<{ ticketId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  requireModulePage('support');
  const { ticketId } = await params;
  if (!isTicketId(ticketId)) notFound();
  return <SupportDeskPage searchParams={await searchParams} openTicketId={ticketId} />;
}
