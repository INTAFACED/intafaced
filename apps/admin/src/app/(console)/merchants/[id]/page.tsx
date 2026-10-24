import { notFound } from 'next/navigation';
import { MerchantDetailView, parseTab } from '@/components/merchants/merchant-detail';
import { dayOf } from '@/lib/merchants/dates';
import { loadNotes } from '@/lib/founder-ops/reads';
import { loadKybReview } from '@/lib/merchants/kyb-review';
import { loadKybRequests } from '@/lib/merchants/kyb-requests';
import { loadMerchantApprovals, loadMerchantControls, loadMerchantDetail, loadMerchantHalts, parsePreset } from '@/lib/merchants/loaders';
import { isTestData } from '@/components/merchants/test-data-badge';
import { requireModulePage } from '@/lib/module-page-guard';
import { requireMerchantsFounder } from '@/lib/merchants/page-gate';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function MerchantPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  requireModulePage('merchants');
  const ctx = await requireMerchantsFounder();
  const { id } = await params;
  // A malformed id and an id that does not exist look the same (M1: no existence leak).
  if (!UUID.test(id)) notFound();
  const query = await searchParams;
  const preset = parsePreset(query.window);
  const now = new Date();
  const data = await loadMerchantDetail(ctx, id.toLowerCase(), preset, now);
  if (data.metrics.kind === 'not_found' || data.series.kind === 'not_found') notFound();
  const tab = parseTab(query.tab);
  const merchantId = id.toLowerCase();
  // Only the open tab reads its own procedures, so the overview does not pay for them.
  const tabData =
    tab === 'controls'
      ? { controls: await loadMerchantControls(ctx, merchantId, now) }
      : tab === 'approvals'
        ? { approvals: await loadMerchantApprovals(ctx, now) }
        : tab === 'halts'
          ? { halts: await loadMerchantHalts(ctx, merchantId, now) }
          : tab === 'notes'
            ? { notes: await loadNotes(ctx, merchantId, query) }
            : tab === 'verification'
              ? {
                  verification: await loadKybReview(ctx, merchantId),
                  verificationRequests: await loadKybRequests(ctx, merchantId),
                }
              : {};
  return (
    <MerchantDetailView
      merchantId={merchantId}
      data={data}
      tab={tab}
      tabData={tabData}
      query={query}
      currentUserId={ctx.session.userId}
      now={now}
      preset={preset}
      asset={typeof query.asset === 'string' ? query.asset : undefined}
      today={dayOf(now)}
      testData={isTestData()}
    />
  );
}
