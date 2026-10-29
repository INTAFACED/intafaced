import { requireModulePage } from '@/lib/module-page-guard';
import { readQueueQuery } from '@/lib/support/queue-query';
import { SupportDeskPage } from './desk-page';

/** The support desk with no request open. */
export default async function SupportPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  requireModulePage('support');
  return <SupportDeskPage query={readQueueQuery(await searchParams)} />;
}
