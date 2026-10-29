import { SupportDeskPage } from './desk-page';

/**
 * Support queue and help articles: list, ticket, claim (one, or the next in the queue), unclaim, reassign, reply, set
 * status, escalate, case file, rating, and publish or unpublish an article. See `desk-page.tsx`.
 */
export default async function SupportPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return <SupportDeskPage searchParams={await searchParams} />;
}
