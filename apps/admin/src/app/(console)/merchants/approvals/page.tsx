import { ApprovalsQueueView } from '@/components/merchants/approvals-queue';
import { parseApprovalQuery } from '@/lib/merchants/approvals-model';
import { loadApprovalsPage } from '@/lib/merchants/loaders';
import { requireModulePage } from '@/lib/module-page-guard';
import { requireMerchantsFounder } from '@/lib/merchants/page-gate';

export const dynamic = 'force-dynamic';

export default async function ApprovalsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  requireModulePage('merchants');
  const ctx = await requireMerchantsFounder();
  const query = parseApprovalQuery(await searchParams);
  const now = new Date();
  const data = await loadApprovalsPage(ctx, now);
  return <ApprovalsQueueView data={data} query={query} now={now} currentUserId={ctx.session.userId} />;
}
